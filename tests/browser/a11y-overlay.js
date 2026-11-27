// 真实 Chromium DOM 测试：内容浮层的可访问性（借用模态/Toast/Help/Takeover/录制/手动）。
// 只读使用 extension/src 的浮层渲染函数（序列化方式与 chrome.scripting.executeScript 一致），
// 验证 role/aria-modal/aria-live/aria-expanded、焦点初值/归还、Tab 循环与 Escape。
import { borrowBanner as sourceBorrowBanner, borrowToast as sourceBorrowToast, helpOverlayFunc as sourceHelpOverlayFunc, installTakeover as sourceInstallTakeover } from '../../extension/src/overlay-ui.js';
import { installRecordOverlay as sourceInstallRecordOverlay } from '../../extension/src/record-overlay.js';
import { manualOverlayFunc as sourceManualOverlayFunc } from '../../extension/src/manual-overlay.js';
import { overlayTexts } from '../../extension/src/overlay-texts.js';
import { OVERLAY_THEME } from '../../extension/src/overlay-theme.js';

const serialize = (fn) => new Function('return (' + fn.toString() + ')')();
const borrowBanner = serialize(sourceBorrowBanner);
const borrowToast = serialize(sourceBorrowToast);
const helpOverlayFunc = serialize(sourceHelpOverlayFunc);
const installTakeover = serialize(sourceInstallTakeover);
const installRecordOverlay = serialize(sourceInstallRecordOverlay);
const manualOverlayFunc = serialize(sourceManualOverlayFunc);

const messages = [];
globalThis.chrome = {
  runtime: {
    id: 'a11y-overlay-test',
    sendMessage(message) {
      messages.push(message);
      return Promise.resolve({ ok: true });
    },
  },
  storage: {
    local: { async get() { return {}; } },
    onChanged: { addListener() {}, removeListener() {} },
  },
};

const fail = (message) => { throw new Error(message); };
const assert = (value, message) => { if (!value) fail(message); };
const click = (element) => {
  assert(element, '要点击的元素不存在');
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
};
const key = (element, keyName, shiftKey = false) => {
  element.dispatchEvent(new KeyboardEvent('keydown', { key: keyName, shiftKey, bubbles: true, cancelable: true }));
};
const accessibleName = (element) => String(
  element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent || '',
).trim();
const clean = () => {
  for (const node of document.querySelectorAll('[data-bb-overlay], [data-bb-ui]')) node.remove();
  for (const id of ['__bb_borrow_modal', '__bb_borrow_toast_host', '__bb_help_host', '__bb_help_highlight', '__bb_record_host', '__bb_manual_host']) {
    document.getElementById(id)?.remove();
  }
  document.documentElement.removeAttribute('data-bb-theme');
  messages.length = 0;
};

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('借用模态：role=dialog/aria-modal/aria-label，初始焦点与焦点归还', () => {
  const before = document.getElementById('before');
  before.focus();
  borrowBanner('a11y-borrow', '可访问性标签页', 5000, 'zh', OVERLAY_THEME);
  const host = document.getElementById('__bb_borrow_modal');
  assert(host, '借用模态未创建');
  assert(host.getAttribute('role') === 'dialog', '借用模态 role 不是 dialog');
  assert(host.getAttribute('aria-modal') === 'true', '借用模态缺 aria-modal');
  assert(accessibleName(host) === overlayTexts('zh').borrow.title, '借用模态缺 aria-label 标题');
  const deny = host.querySelector('[data-deny]');
  const allow = host.querySelector('[data-allow]');
  assert(document.activeElement === deny, '初始焦点不在“拒绝”');
  key(deny, 'Tab');
  assert(document.activeElement === allow, 'Tab 没有从拒绝移到允许');
  key(allow, 'Tab');
  assert(document.activeElement === deny, 'Tab 没有回绕到拒绝');
  key(deny, 'Tab', true);
  assert(document.activeElement === allow, 'Shift+Tab 没有从拒绝回绕到允许');
  assert(accessibleName(allow) === overlayTexts('zh').borrow.allow, '允许按钮没有可访问名称');
  click(deny);
  assert(!document.getElementById('__bb_borrow_modal'), '拒绝后模态没有移除');
  assert(document.activeElement === before, '关闭后焦点没有回到打开前的元素');
  const decision = messages[messages.length - 1];
  assert(decision && decision.type === 'bb.borrow.decision' && decision.allow === false, '拒绝没有结算');
});

test('借用模态：Escape 关闭并结算为拒绝（不误判为允许）', () => {
  borrowBanner('a11y-escape', 'Escape 标签页', 5000, 'zh', OVERLAY_THEME);
  const host = document.getElementById('__bb_borrow_modal');
  const deny = host.querySelector('[data-deny]');
  deny.focus();
  key(deny, 'Escape');
  assert(!document.getElementById('__bb_borrow_modal'), 'Escape 后模态没有移除');
  const decision = messages[messages.length - 1];
  assert(decision && decision.type === 'bb.borrow.decision' && decision.allow === false, 'Escape 没有按拒绝结算');
  assert(decision.timedOut === false, 'Escape 不应标记超时');
});

test('借用 Toast：role=region、倒计时文本、关闭按钮有可访问名称', () => {
  borrowToast('a11y-toast', 'Toast 标签页', 3000, 'en', OVERLAY_THEME);
  const host = document.getElementById('__bb_borrow_toast_host');
  assert(host, '借用 Toast 未创建');
  assert(host.getAttribute('role') === 'region', 'Toast role 不是 region');
  const item = host.querySelector('[data-request="a11y-toast"]');
  assert(item, 'Toast 项缺失');
  assert(item.querySelector('[data-count]').textContent === '3s', '倒计时文本不对');
  const buttons = [...item.querySelectorAll('button')];
  assert(buttons.length >= 2, 'Toast 按钮数量异常');
  for (const button of buttons) assert(accessibleName(button), 'Toast 按钮缺可访问名称');
  click(item.querySelector('[data-close]'));
  assert(!document.getElementById('__bb_borrow_toast_host'), '关闭后 Toast 没有移除');
});

test('Help：role=dialog、textarea aria-label、折叠按钮 aria-expanded/aria-label 同步', () => {
  helpOverlayFunc('a11y-help', '请完成验证', '#help-target', null, '需要人工协助', 'zh', OVERLAY_THEME);
  const host = document.getElementById('__bb_help_host');
  assert(host, 'Help 宿主未创建');
  const shadow = globalThis.__bbHelpRoots.get(host);
  assert(shadow, 'Help shadow root 不可访问');
  const card = shadow.querySelector('.card');
  assert(card.getAttribute('role') === 'dialog', 'Help 卡片 role 不是 dialog');
  assert(accessibleName(card), 'Help 卡片缺 aria-label');
  const note = shadow.querySelector('.note');
  assert(note.getAttribute('aria-label'), 'Help textarea 缺 aria-label');
  assert(note.getAttribute('placeholder'), 'Help textarea 缺 placeholder');
  const chev = shadow.querySelector('.chev');
  assert(chev.getAttribute('aria-expanded') === 'true', '折叠按钮初始 aria-expanded 不对');
  const expandedLabel = chev.getAttribute('aria-label');
  assert(expandedLabel, '折叠按钮缺 aria-label');
  click(chev);
  assert(chev.getAttribute('aria-expanded') === 'false', '点击后 aria-expanded 没有变 false');
  assert(chev.getAttribute('aria-label') !== expandedLabel, '折叠/展开的 aria-label 没有区分');
  for (const control of shadow.querySelectorAll('button, textarea')) {
    assert(!control.hasAttribute('tabindex') || control.getAttribute('tabindex') !== '-1', 'Help 控件不应被 Tab 跳过');
    assert(accessibleName(control) || control.getAttribute('placeholder'), 'Help 控件缺可访问名称');
  }
});

test('Takeover：role=region、状态 aria-live=polite、最小化 aria-expanded 与焦点', () => {
  installTakeover({ sessionId: 'a11y-sess', mode: 'ready', paused: false }, 'zh', 100, OVERLAY_THEME);
  const host = document.querySelector('[data-bb-ui="takeover"]');
  assert(host, '接管浮层未创建');
  const shadow = globalThis.__bbTakeoverRoots.get(host);
  assert(shadow, '接管 shadow root 不可访问');
  const card = shadow.querySelector('.card');
  assert(card.getAttribute('role') === 'region', '接管卡片 role 不是 region');
  assert(accessibleName(card), '接管卡片缺 aria-label');
  const status = card.querySelector('.status-row');
  assert(status.getAttribute('role') === 'status', '状态区 role 不是 status');
  assert(status.getAttribute('aria-live') === 'polite', '状态区缺 aria-live=polite');
  const minimize = shadow.querySelector('[data-act="min"]');
  assert(minimize.getAttribute('aria-expanded') === 'true', '最小化按钮初始 aria-expanded 应为 true（未收起）');
  const mini = shadow.querySelector('[data-mini]');
  assert(mini.getAttribute('aria-expanded') === 'false', 'mini 初始 aria-expanded 不对');
  click(minimize);
  assert(mini.getAttribute('aria-expanded') === 'false', '最小化后 mini aria-expanded 应为 false（卡片已收起）');
  assert(minimize.getAttribute('aria-expanded') === 'false', '最小化后收起按钮 aria-expanded 没有变 false');
  assert(card.style.display === 'none', '最小化后卡片没有隐藏');
  assert(shadow.activeElement === mini, '最小化后焦点没有到 mini');
  click(mini);
  assert(mini.getAttribute('aria-expanded') === 'true', '恢复后 mini aria-expanded 没有变 true');
  assert(minimize.getAttribute('aria-expanded') === 'true', '恢复后收起按钮 aria-expanded 没有变 true');
  assert(card.style.display !== 'none', '恢复后卡片仍然隐藏');
  assert(accessibleName(mini), 'mini 缺可访问名称');
  const buttons = [...shadow.querySelectorAll('button')];
  assert(buttons.length >= 4, '接管按钮数量异常');
  for (const button of buttons) assert(accessibleName(button), '接管按钮缺可访问名称');
});

test('录制/手动长截图浮层：按钮有可访问名称、主题/dir 标记仍在', () => {
  installRecordOverlay(Date.now(), 'zh', OVERLAY_THEME);
  const record = document.getElementById('__bb_record_host');
  assert(record, '录制浮层未创建');
  assert(record.getAttribute('dir') === 'ltr', '录制浮层缺 dir');
  assert(record.getAttribute('data-bb-theme'), '录制浮层缺主题标记');
  const recordButtons = [...record.shadowRoot.querySelectorAll('button')];
  assert(recordButtons.length >= 1, '录制浮层没有按钮');
  for (const button of recordButtons) assert(accessibleName(button), '录制按钮缺可访问名称');
  record.remove();

  manualOverlayFunc(0, 'zh', OVERLAY_THEME);
  const manual = document.getElementById('__bb_manual_host');
  assert(manual, '手动长截图浮层未创建');
  const manualButtons = [...manual.shadowRoot.querySelectorAll('button')];
  assert(manualButtons.length >= 2, '手动长截图按钮数量异常');
  for (const button of manualButtons) assert(accessibleName(button), '手动长截图按钮缺可访问名称');
  manual.remove();
});

test('RTL：ar 浮层宿主 dir=rtl 且 aria-label 使用阿拉伯语标题', () => {
  const ar = overlayTexts('ar');
  borrowBanner('a11y-rtl', 'RTL tab', 5000, 'ar', OVERLAY_THEME, ar);
  const host = document.getElementById('__bb_borrow_modal');
  assert(host.getAttribute('dir') === 'rtl', 'RTL 借用模态缺 dir=rtl');
  assert(accessibleName(host) === ar.borrow.title, 'RTL 借用模态 aria-label 没有本地化');
  const allow = host.querySelector('[data-allow]');
  assert(accessibleName(allow) === ar.borrow.allow, 'RTL 允许按钮文案没有本地化');
  // RTL 下 Tab 循环顺序仍按 DOM 顺序（拒绝 → 允许 → 回绕），不随视觉方向反转。
  const deny = host.querySelector('[data-deny]');
  deny.focus();
  key(deny, 'Tab');
  assert(document.activeElement === allow, 'RTL 下 Tab 顺序不对');
  key(allow, 'Tab');
  assert(document.activeElement === deny, 'RTL 下 Tab 没有回绕');
  click(host.querySelector('[data-cancel]') || deny);
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) {
    try {
      document.title = 'A11Y_OVERLAY_PROGRESS:' + passed + ':' + name;
      await fn();
      passed += 1;
      clean();
    } catch (error) {
      clean();
      document.title = 'A11Y_OVERLAY_FAIL:' + name + ':' + String((error && error.message) || error);
      return;
    }
  }
  document.title = 'A11Y_OVERLAY_OK:' + passed;
})();
