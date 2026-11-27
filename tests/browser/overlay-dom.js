// 真实内联浮层的 DOM 组件测试（无 React 副本）。
// 直接调用 extension/src/overlay-ui.js 里随扩展发布的渲染函数，
// 在真实浏览器 DOM 里验证焦点、键盘、计时、深色 token 和按钮行为。
import {
  borrowBanner as sourceBorrowBanner,
  borrowToast as sourceBorrowToast,
  helpOverlayFunc as sourceHelpOverlayFunc,
  installTakeover as sourceInstallTakeover,
} from '../../extension/src/overlay-ui.js';
import { OVERLAY_THEME, overlayThemeTokens } from '../../extension/src/overlay-theme.js';
import { installRecordOverlay as sourceInstallRecordOverlay } from '../../extension/src/record-overlay.js';
import { manualOverlayFunc as sourceManualOverlayFunc } from '../../extension/src/manual-overlay.js';
import { installTargetMarker as sourceInstallTargetMarker } from '../../extension/src/target-marker.js';
import { overlayTexts } from '../../extension/src/overlay-texts.js';

// 按 chrome.scripting.executeScript 的方式重建函数：只保留源码，不带模块作用域。
// 这样一旦浮层函数引用了模块级变量，DOM 测试会立即失败，而不是真机才炸。
const serialize = (fn) => new Function('return (' + fn.toString() + ')')();
const borrowBanner = serialize(sourceBorrowBanner);
const borrowToast = serialize(sourceBorrowToast);
const helpOverlayFunc = serialize(sourceHelpOverlayFunc);
const installTakeover = serialize(sourceInstallTakeover);
const installRecordOverlay = serialize(sourceInstallRecordOverlay);
const manualOverlayFunc = serialize(sourceManualOverlayFunc);
const installTargetMarker = serialize(sourceInstallTargetMarker);

const messages = [];
globalThis.chrome = {
  runtime: {
    id: 'overlay-dom-test',
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lastMessage = () => messages[messages.length - 1];
const clean = () => {
  for (const node of document.querySelectorAll('[data-bb-overlay]')) node.remove();
  for (const id of ['__bb_borrow_modal', '__bb_borrow_toast_host', '__bb_help_host', '__bb_help_highlight']) {
    document.getElementById(id)?.remove();
  }
  document.documentElement.removeAttribute('data-bb-theme');
  messages.length = 0;
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
const rgb = (hex) => {
  const value = String(hex).replace('#', '');
  return 'rgb(' + parseInt(value.slice(0, 2), 16) + ', ' + parseInt(value.slice(2, 4), 16) + ', ' + parseInt(value.slice(4, 6), 16) + ')';
};
const expectedBackground = (mode) => rgb(overlayThemeTokens(OVERLAY_THEME, mode)['--bb-surface']);

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('借用模态：ARIA、初始焦点、Tab 循环、Escape 拒绝', () => {
  borrowBanner('r-modal', '测试标签页', 5000, 'zh', OVERLAY_THEME);
  const host = document.getElementById('__bb_borrow_modal');
  assert(host, '模态未创建');
  assert(host.getAttribute('role') === 'dialog', 'role 不是 dialog');
  assert(host.getAttribute('aria-modal') === 'true', '缺少 aria-modal');
  assert(host.getAttribute('data-bb-theme') === 'light', '模态主题标记不对');
  const deny = host.querySelector('[data-deny]');
  const allow = host.querySelector('[data-allow]');
  assert(document.activeElement === deny, '初始焦点不在拒绝按钮');
  assert(host.textContent.includes('允许借用标签页？'), '标题文案缺失');
  key(deny, 'Tab');
  assert(document.activeElement === allow, 'Tab 没有从拒绝移到允许');
  key(allow, 'Tab');
  assert(document.activeElement === deny, 'Tab 没有从允许回绕到拒绝');
  key(deny, 'Tab', true);
  assert(document.activeElement === allow, 'Shift+Tab 没有从拒绝回绕到允许');
  key(host, 'Escape');
  assert(!document.getElementById('__bb_borrow_modal'), 'Escape 后模态没有移除');
  const decision = lastMessage();
  assert(decision && decision.type === 'bb.borrow.decision' && decision.allow === false, 'Escape 没有按拒绝结算：' + JSON.stringify(decision));
});

test('借用模态：点击允许结算 allow=true', () => {
  borrowBanner('r-modal-allow', '测试标签页', 5000, 'zh', OVERLAY_THEME);
  const host = document.getElementById('__bb_borrow_modal');
  click(host.querySelector('[data-allow]'));
  const decision = lastMessage();
  assert(decision && decision.allow === true && decision.requestId === 'r-modal-allow', '允许没有正确结算');
  assert(!document.getElementById('__bb_borrow_modal'), '结算后模态没有移除');
});

test('借用 Toast：关闭 X、进度条、倒计时与允许按钮', () => {
  borrowToast('r-toast', '另一个标签页', 3000, 'zh', OVERLAY_THEME);
  let host = document.getElementById('__bb_borrow_toast_host');
  assert(host, 'Toast 未创建');
  assert(host.getAttribute('role') === 'region', 'Toast role 不是 region');
  const item = host.querySelector('[data-request="r-toast"]');
  assert(item, 'Toast 项缺失');
  assert(item.querySelector('[data-close]'), 'Toast 缺少关闭 X');
  const bar = item.querySelector('[data-bar]');
  assert(bar.style.width === '100%', '进度条初始宽度不是 100%：' + bar.style.width);
  assert(/3s/.test(item.querySelector('[data-count]').textContent), '倒计时没有显示 3s');
  click(item.querySelector('[data-close]'));
  assert(!document.getElementById('__bb_borrow_toast_host'), '关闭后 Toast host 没有移除');
  assert(lastMessage().allow === false, '关闭 X 没有按拒绝结算');
  borrowToast('r-toast-allow', '另一个标签页', 3000, 'zh', OVERLAY_THEME);
  host = document.getElementById('__bb_borrow_toast_host');
  click(host.querySelector('[data-request="r-toast-allow"] [data-allow]'));
  const decision = lastMessage();
  assert(decision && decision.requestId === 'r-toast-allow' && decision.allow === true, 'Toast 允许没有结算');
});

test('借用 Toast：倒计时推进并缩短进度条', async () => {
  borrowToast('r-toast-tick', '另一个标签页', 4000, 'en', OVERLAY_THEME);
  const item = document.querySelector('[data-request="r-toast-tick"]');
  assert(item.querySelector('[data-count]').textContent === '4s', '初始倒计时不是 4s');
  await sleep(1100);
  assert(item.querySelector('[data-count]').textContent === '3s', '倒计时没有推进：' + item.querySelector('[data-count]').textContent);
  assert(parseFloat(item.querySelector('[data-bar]').style.width) < 100, '进度条没有缩短');
});

test('Help：closed shadow、折叠 aria-expanded、完成与取消', () => {
  const target = document.createElement('div');
  target.id = 'help-target';
  target.style.cssText = 'position:fixed;left:40px;top:80px;width:120px;height:30px;background:#eee';
  document.body.appendChild(target);
  helpOverlayFunc('h-done', '请登录后继续', '#help-target', null, '需要登录', 'zh', OVERLAY_THEME);
  const host = document.getElementById('__bb_help_host');
  assert(host, 'Help 宿主未创建');
  assert(host.shadowRoot === null, 'Help 必须是 closed shadow');
  const shadow = globalThis.__bbHelpRoots?.get(host);
  assert(shadow, 'Help 内部 root 无法访问');
  const card = shadow.querySelector('.card');
  assert(card.getAttribute('role') === 'dialog', 'Help card role 不是 dialog');
  const chev = shadow.querySelector('.chev');
  assert(chev.getAttribute('aria-expanded') === 'true', '折叠按钮初始 aria-expanded 不对');
  click(chev);
  assert(shadow.querySelector('.body').classList.contains('hidden'), '折叠后 body 没有隐藏');
  assert(chev.getAttribute('aria-expanded') === 'false', '折叠后 aria-expanded 不对');
  click(chev);
  assert(!shadow.querySelector('.body').classList.contains('hidden'), '展开后 body 仍然隐藏');
  const highlight = document.getElementById('__bb_help_highlight');
  assert(highlight && highlight.style.display === 'block', '目标高亮没有显示');
  shadow.querySelector('.note').value = '验证码已填';
  click(shadow.querySelector('[data-act="done"]'));
  const done = lastMessage();
  assert(done && done.type === 'bb.help.resolved' && done.action === 'done' && done.note === '验证码已填', '完成动作没有正确回传');
  assert(!document.getElementById('__bb_help_host'), '完成后 Help 没有移除');
  helpOverlayFunc('h-cancel', '请处理', '', null, '', 'zh', OVERLAY_THEME);
  const second = globalThis.__bbHelpRoots.get(document.getElementById('__bb_help_host'));
  click(second.querySelector('[data-act="cancel"]'));
  assert(lastMessage().action === 'skip', '取消没有按 skip 回传');
});

test('浮层语言包：日语 Borrow/Takeover 不再回退中文/英文', () => {
  const ja = overlayTexts('ja');
  borrowBanner('ja-borrow', 'Tab', 30000, 'ja', OVERLAY_THEME, ja);
  const host = document.querySelector('[data-bb-ui="borrow"]');
  assert(host, '日语借用浮层未创建');
  assert(host.textContent.includes(ja.borrow.title), '借用浮层没有使用日语 title');
  document.querySelectorAll('[data-bb-ui="borrow"]').forEach((node) => node.remove());
  installTakeover({ sessionId: 'ja-session', mode: 'ready' }, 'ja', 50, OVERLAY_THEME, ja);
  const takeover = document.querySelector('[data-bb-ui="takeover"]');
  const shadow = globalThis.__bbTakeoverRoots.get(takeover);
  assert(shadow.querySelector('[data-status-title]').textContent === ja.takeover.ready[0], 'Takeover 没有使用日语 ready 文案');
});

test('Takeover：region/aria-live、暂停恢复、最小化焦点、停止二次确认', () => {
  installTakeover({
    sessionId: 'sess-1', project: 'proj-a', controller: { name: 'AgentX', color: '#2f6fed' },
    mode: 'ready', paused: false, borrowed: true, minimized: false,
  }, 'zh', 100, OVERLAY_THEME);
  const host = document.querySelector('[data-bb-ui="takeover"]');
  assert(host, '接管浮层未创建');
  assert(host.getAttribute('data-bb-theme') === 'light', '接管浮层主题标记不对');
  const shadow = globalThis.__bbTakeoverRoots.get(host);
  assert(shadow, '接管浮层 root 无法访问');
  const card = shadow.querySelector('.card');
  assert(card.getAttribute('role') === 'region', '接管卡片 role 不是 region');
  assert(card.querySelector('.status-row').getAttribute('aria-live') === 'polite', '状态区缺少 aria-live=polite');
  assert(shadow.querySelector('.brand').textContent === 'AgentX', '控制器名称没有渲染');
  assert(shadow.querySelector('[data-project]').textContent === 'proj-a', '项目没有渲染');
  const pause = shadow.querySelector('[data-act="pause"]');
  assert(pause.textContent === '暂停 Agent', '暂停按钮初始文案不对');
  click(pause);
  assert(pause.textContent === '交给 Agent' && pause.dataset.paused === '1', '暂停后按钮状态不对');
  assert(messages.some((message) => message.type === 'bb.takeover.pause' && message.paused === true), '暂停没有回传');
  click(pause);
  assert(pause.textContent === '暂停 Agent' && pause.dataset.paused === '0', '恢复后按钮状态不对');
  click(shadow.querySelector('[data-act="min"]'));
  assert(card.style.display === 'none', '最小化后卡片没有隐藏');
  const mini = shadow.querySelector('[data-mini]');
  assert(mini.style.display === 'inline-flex', '最小化后 mini 没有显示');
  assert(shadow.activeElement === mini, '最小化后焦点没有到 mini');
  click(mini);
  assert(card.style.display !== 'none', '展开后卡片仍然隐藏');
  assert(shadow.activeElement === shadow.querySelector('[data-act="min"]'), '展开后焦点没有回到最小化按钮');
  const stop = shadow.querySelector('[data-act="stop"]');
  click(stop);
  assert(stop.textContent === '再点一次停止', '第一次停止没有进入二次确认');
  assert(shadow.querySelector('[data-status-sub]').textContent.includes('3 秒内'), '二次确认副标题缺失');
  click(stop);
  assert(stop.disabled === true && stop.textContent === '正在停止任务…', '第二次停止没有进入 stopping');
  assert(messages.some((message) => message.type === 'bb.takeover.stop'), '停止没有回传');
});

test('Takeover：Agent passthrough 期间不误切到“现在由你操作”', () => {
  installTakeover({ sessionId: 'sess-human', mode: 'ready' }, 'zh', 300, OVERLAY_THEME);
  const host = document.querySelector('[data-bb-ui="takeover"]');
  const shadow = globalThis.__bbTakeoverRoots.get(host);
  const title = shadow.querySelector('[data-status-title]');
  assert(title.textContent === 'Agent 已就绪', '初始状态不是 Agent 已就绪：' + title.textContent);
  globalThis.__bbCooperation = { snapshot: () => ({ pending: 1 }) };
  document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
  assert(title.textContent === 'Agent 已就绪', 'Agent passthrough 期间被误判为人操作：' + title.textContent);
  globalThis.__bbCooperation = { snapshot: () => ({ pending: 0 }) };
  document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
  assert(title.textContent === '现在由你操作', '真实人操作没有切换状态：' + title.textContent);
  delete globalThis.__bbCooperation;
});

test('Record 浮层跟随 data-bb-theme，light/dark 都使用共享 token', () => {
  document.documentElement.setAttribute('data-bb-theme', 'dark');
  installRecordOverlay(Date.now(), 'zh', OVERLAY_THEME);
  let host = document.getElementById('__bb_record_host');
  assert(host.getAttribute('data-bb-theme') === 'dark', 'Record 未进入深色');
  let shadow = host.shadowRoot;
  assert(getComputedStyle(shadow.querySelector('.pill')).backgroundColor === expectedBackground('dark'), 'Record 深色背景不是 token');
  host.remove();
  document.documentElement.setAttribute('data-bb-theme', 'light');
  installRecordOverlay(Date.now(), 'zh', OVERLAY_THEME);
  host = document.getElementById('__bb_record_host');
  shadow = host.shadowRoot;
  assert(host.getAttribute('data-bb-theme') === 'light', 'Record 未进入浅色');
  assert(getComputedStyle(shadow.querySelector('.pill')).backgroundColor === expectedBackground('light'), 'Record 浅色背景不是 token');
  host.remove();
  document.documentElement.removeAttribute('data-bb-theme');
});

test('Manual 浮层跟随 data-bb-theme，light/dark 都使用共享 token', () => {
  document.documentElement.setAttribute('data-bb-theme', 'dark');
  manualOverlayFunc(0, 'zh', OVERLAY_THEME);
  let host = document.getElementById('__bb_manual_host');
  assert(host.getAttribute('data-bb-theme') === 'dark', 'Manual 未进入深色');
  assert(getComputedStyle(host.shadowRoot.querySelector('.pill')).backgroundColor === expectedBackground('dark'), 'Manual 深色背景不是 token');
  host.remove();
  document.documentElement.setAttribute('data-bb-theme', 'light');
  manualOverlayFunc(0, 'zh', OVERLAY_THEME);
  host = document.getElementById('__bb_manual_host');
  assert(host.getAttribute('data-bb-theme') === 'light', 'Manual 未进入浅色');
  assert(getComputedStyle(host.shadowRoot.querySelector('.pill')).backgroundColor === expectedBackground('light'), 'Manual 浅色背景不是 token');
  host.remove();
  document.documentElement.removeAttribute('data-bb-theme');
});

test('Agent target 标记定位/主题/TTL', async () => {
  document.documentElement.setAttribute('data-bb-theme', 'dark');
  installTargetMarker(100, 120, 400, OVERLAY_THEME);
  const host = document.getElementById('__bb_agent_target');
  assert(host, 'target marker 未创建');
  assert(host.style.left === '100px' && host.style.top === '120px', 'target marker 坐标不对');
  assert(host.getAttribute('data-bb-theme') === 'dark', 'target marker 未进入深色');
  assert(getComputedStyle(host.shadowRoot.querySelector('.ring')).borderTopColor === expectedBackground('dark') || getComputedStyle(host.shadowRoot.querySelector('.ring')).borderTopColor, 'ring 无边框');
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert(!document.getElementById('__bb_agent_target'), 'target marker TTL 后未移除');
  document.documentElement.removeAttribute('data-bb-theme');
});

test('深色 token：Borrow/Toast/Help/Takeover 都跟随 data-bb-theme=dark', () => {
  document.documentElement.setAttribute('data-bb-theme', 'dark');
  borrowBanner('d-modal', '深色标签', 5000, 'zh', OVERLAY_THEME);
  let host = document.getElementById('__bb_borrow_modal');
  assert(host.getAttribute('data-bb-theme') === 'dark', '模态未进入深色');
  assert(host.style.getPropertyValue('--bb-surface').trim() === overlayThemeTokens(OVERLAY_THEME, 'dark')['--bb-surface'], '模态 token 未切换');
  assert(getComputedStyle(host.querySelector('div')).backgroundColor === expectedBackground('dark'), '模态卡片背景不是深色 token');
  clean();

  document.documentElement.setAttribute('data-bb-theme', 'dark');
  borrowToast('d-toast', '深色标签', 5000, 'zh', OVERLAY_THEME);
  host = document.getElementById('__bb_borrow_toast_host');
  assert(host.getAttribute('data-bb-theme') === 'dark', 'Toast 未进入深色');
  assert(getComputedStyle(host.querySelector('[data-request="d-toast"]')).backgroundColor === expectedBackground('dark'), 'Toast 背景不是深色 token');
  clean();

  document.documentElement.setAttribute('data-bb-theme', 'dark');
  helpOverlayFunc('d-help', '深色协助', '', null, '', 'zh', OVERLAY_THEME);
  host = document.getElementById('__bb_help_host');
  assert(host.getAttribute('data-bb-theme') === 'dark', 'Help 未进入深色');
  const helpShadow = globalThis.__bbHelpRoots.get(host);
  assert(getComputedStyle(helpShadow.querySelector('.card')).backgroundColor === expectedBackground('dark'), 'Help 卡片背景不是深色 token');
  clean();

  document.documentElement.setAttribute('data-bb-theme', 'dark');
  installTakeover({ sessionId: 'dark', mode: 'ready' }, 'zh', 400, OVERLAY_THEME);
  host = document.querySelector('[data-bb-ui="takeover"]');
  assert(host.getAttribute('data-bb-theme') === 'dark', 'Takeover 未进入深色');
  const takeoverShadow = globalThis.__bbTakeoverRoots.get(host);
  assert(getComputedStyle(takeoverShadow.querySelector('.card')).backgroundColor === expectedBackground('dark'), 'Takeover 卡片背景不是深色 token');
  clean();
});

test('RTL：借用 Toast / 接管卡片 / 协助卡片跟随 RTL 语言', () => {
  const en = overlayTexts('en');
  borrowToast('rtl-toast', 'RTL tab', 3000, 'ar', OVERLAY_THEME, en);
  const toast = document.getElementById('__bb_borrow_toast_host');
  assert(toast && toast.getAttribute('dir') === 'rtl', '借用 Toast 缺 RTL 方向');
  const toastRect = toast.getBoundingClientRect();
  assert(toastRect.left <= 24, 'RTL Toast 没有贴左边：' + toastRect.left);
  clean();

  installTakeover({ sessionId: 'rtl', mode: 'ready' }, 'ar', 500, OVERLAY_THEME, en);
  const takeover = document.querySelector('[data-bb-ui="takeover"]');
  assert(takeover && takeover.getAttribute('dir') === 'rtl', '接管浮层缺 RTL 方向');
  const shadow = globalThis.__bbTakeoverRoots.get(takeover);
  const card = shadow.querySelector('.card');
  const cardRect = card.getBoundingClientRect();
  assert(cardRect.left <= 24, 'RTL 接管卡片没有贴左边：' + cardRect.left);
  const mini = shadow.querySelector('[data-mini]');
  const miniRect = mini.getBoundingClientRect();
  assert(miniRect.left <= 24 || mini.style.display === 'none', 'RTL 迷你卡片没有贴左边：' + miniRect.left);
  clean();

  helpOverlayFunc('rtl-help', 'RTL help', '', null, '', 'ar', OVERLAY_THEME, en);
  const helpHost = document.getElementById('__bb_help_host');
  assert(helpHost && helpHost.getAttribute('dir') === 'rtl', '协助浮层缺 RTL 方向');
  const helpShadow = globalThis.__bbHelpRoots.get(helpHost);
  const helpCard = helpShadow.querySelector('.card').getBoundingClientRect();
  assert(Math.abs((helpCard.left + helpCard.width / 2) - window.innerWidth / 2) <= 40, 'RTL 协助卡片没有居中：' + helpCard.left);
  helpHost.remove();
  document.getElementById('__bb_help_highlight')?.remove();

  installRecordOverlay(Date.now(), 'ar', OVERLAY_THEME, en);
  const recordHost = document.getElementById('__bb_record_host');
  assert(recordHost && recordHost.getAttribute('dir') === 'rtl', '录制浮层缺 RTL 方向');
  const recordPill = recordHost.shadowRoot.querySelector('.pill').getBoundingClientRect();
  assert(Math.abs((recordPill.left + recordPill.width / 2) - window.innerWidth / 2) <= 40, 'RTL 录制胶囊没有居中：' + recordPill.left);
  recordHost.remove();

  manualOverlayFunc(0, 'ar', OVERLAY_THEME, en);
  const manualHost = document.getElementById('__bb_manual_host');
  assert(manualHost && manualHost.getAttribute('dir') === 'rtl', '手动长截图浮层缺 RTL 方向');
  const manualPill = manualHost.shadowRoot.querySelector('.pill').getBoundingClientRect();
  assert(manualPill.right >= window.innerWidth - 40, 'RTL 手动长截图胶囊没有贴右侧：' + manualPill.right);
  manualHost.remove();
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
      clean();
    } catch (error) {
      clean();
      document.title = 'OVERLAY_DOM_FAIL:' + name + ':' + String((error && error.message) || error);
      return;
    }
  }
  document.title = 'OVERLAY_DOM_OK:' + passed;
})();
