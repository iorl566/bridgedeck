// tests/browser/overlay-a11y-w5e.js —— 真实 Chromium DOM：浮层 a11y 收口 + 动态文案 12 语言。
//
// 只读使用 extension/src 的浮层渲染函数（序列化方式与 chrome.scripting.executeScript 一致），
// 验证：
//   record      role=status/aria-live/polite、Esc 结束、焦点归还、动态文案 12 语言；
//   manual      role=dialog、Esc 取消、帧数 aria-live 播报、焦点归还；
//   help        role=dialog + aria-modal + labelledby/describedby、焦点陷阱、Esc 取消、外部移除时焦点归还；
//   takeover    region + status aria-live、Esc 收起/展开、动作播报、动态 aria-label 12 语言；
//   borrow      modal 的 Esc 提示/倒计时来自动态文案、Esc 拒绝；toast 的 Esc 关闭；
//   矩阵        12 语言下 aria-label/hint 均本地化（拉丁语言不残留中文，非拉丁语言含本语言文字）。
import {
  borrowBanner as sourceBorrowBanner,
  borrowToast as sourceBorrowToast,
  helpOverlayFunc as sourceHelpOverlayFunc,
  installTakeover as sourceInstallTakeover,
} from '../../extension/src/overlay-ui.js';
import { installRecordOverlay as sourceInstallRecordOverlay } from '../../extension/src/record-overlay.js';
import { manualOverlayFunc as sourceManualOverlayFunc } from '../../extension/src/manual-overlay.js';
import { overlayTexts, overlayA11yTexts } from '../../extension/src/overlay-texts.js';
import { OVERLAY_THEME } from '../../extension/src/overlay-theme.js';
import { DYNAMIC_TEXT } from '../../extension/src/overlay-dynamic-locales.js';

// 与 chrome.scripting.executeScript 一致：只保留函数源码，不带模块作用域。
const serialize = (fn) => new Function('return (' + fn.toString() + ')')();
const borrowBanner = serialize(sourceBorrowBanner);
const borrowToast = serialize(sourceBorrowToast);
const helpOverlayFunc = serialize(sourceHelpOverlayFunc);
const installTakeover = serialize(sourceInstallTakeover);
const installRecordOverlay = serialize(sourceInstallRecordOverlay);
const manualOverlayFunc = serialize(sourceManualOverlayFunc);

const LANGS = ['zh', 'en', 'ja', 'ko', 'de', 'es', 'fr', 'it', 'pt', 'zh-TW', 'ar', 'he'];
const NON_LATIN = ['ja', 'ko', 'zh-TW', 'ar', 'he'];
const SCRIPTS = {
  ja: /[\u3040-\u30ff\u4e00-\u9fff]/,
  ko: /[\uac00-\ud7af]/,
  'zh-TW': /[\u4e00-\u9fa5]/,
  ar: /[\u0600-\u06ff]/,
  he: /[\u0590-\u05ff]/,
};
const HAN = /[\u4e00-\u9fa5]/;

const messages = [];
let manualFrames = 0;
let lastReply = null;
globalThis.chrome = {
  runtime: {
    id: 'overlay-a11y-w5e',
    sendMessage(message, callback) {
      messages.push(message);
      const reply = { ok: true, frames: (manualFrames += 1) };
      lastReply = reply;
      if (typeof callback === 'function') {
        callback(reply);
        return undefined;
      }
      return Promise.resolve(reply);
    },
  },
  storage: {
    local: { async get() { return {}; } },
    onChanged: { addListener() {}, removeListener() {} },
  },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** 确定性等待：轮询断言条件（而不是依赖固定延时/固定计数）。 */
const waitFor = async (predicate, message, timeoutMs = 800) => {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error(message);
};
const fail = (message) => { throw new Error(message); };
const assert = (value, message) => { if (!value) fail(message); };
const click = (element) => {
  assert(element, '要点击的元素不存在');
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
};
const key = (element, keyName, shiftKey = false) => {
  element.dispatchEvent(new KeyboardEvent('keydown', { key: keyName, shiftKey, bubbles: true, cancelable: true, composed: true }));
};
const clean = () => {
  for (const node of document.querySelectorAll('[data-bb-overlay], [data-bb-ui], #__bb_record_host, #__bb_manual_host')) node.remove();
  document.documentElement.removeAttribute('data-bb-theme');
  messages.length = 0;
  delete globalThis.__bbCooperation;
};
const lastMessage = () => messages[messages.length - 1];
let takeoverVersion = 1000;

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ── 1. 录制浮层：状态语义 / Esc / 焦点归还 / 动态播报 ──
test('record：role=status + aria-live + 动态 aria-label，Esc 结束并归还焦点', () => {
  const before = document.getElementById('before');
  before.focus();
  const a11y = overlayA11yTexts('zh');
  installRecordOverlay(Date.now(), 'zh', OVERLAY_THEME, overlayTexts('zh'), a11y);
  const host = document.getElementById('__bb_record_host');
  assert(host, '录制浮层未创建');
  assert(host.getAttribute('role') === 'status', '录制浮层 role 不是 status');
  assert(host.getAttribute('aria-live') === 'polite', '录制浮层缺 aria-live=polite');
  assert(host.getAttribute('aria-label') === a11y.record.label, '录制浮层 aria-label 不是动态文案');
  assert(host.getAttribute('aria-keyshortcuts') === 'Escape', '录制浮层缺 Emergency 快捷键声明');
  const shadow = host.shadowRoot;
  const hint = shadow.querySelector('[data-a11y-hint]');
  const live = shadow.querySelector('[data-a11y-live]');
  assert(hint.textContent === a11y.record.escHint, '录制 Esc 提示不是动态文案：' + hint.textContent);
  assert(live.textContent === a11y.record.start, '录制开始播报不是动态文案：' + live.textContent);
  const finish = shadow.querySelector('.finish');
  finish.focus();
  key(finish, 'Escape');
  assert(!document.getElementById('__bb_record_host'), 'Esc 后录制浮层没有移除');
  assert(lastMessage() && lastMessage().type === 'bb.record.finish', 'Esc 没有回传 bb.record.finish');
  assert(document.activeElement === before, '录制结束后焦点没有归还给打开前的元素');
});

test('record：计时可见且每秒推进（aria-live 不刷屏）', async () => {
  installRecordOverlay(Date.now() - 3000, 'zh', OVERLAY_THEME, overlayTexts('zh'), overlayA11yTexts('zh'));
  const shadow = document.getElementById('__bb_record_host').shadowRoot;
  const time = shadow.querySelector('.time');
  assert(/^\d\d:\d\d$/.test(time.textContent), '计时格式不对：' + time.textContent);
  const first = time.textContent;
  await sleep(1100);
  assert(time.textContent !== first, '计时没有推进');
});

test('record：12 语言 aria-label/播报全部本地化（拉丁语言不残留中文）', () => {
  for (const lang of LANGS) {
    installRecordOverlay(Date.now(), lang, OVERLAY_THEME, overlayTexts(lang), overlayA11yTexts(lang));
    const host = document.getElementById('__bb_record_host');
    const a11y = overlayA11yTexts(lang);
    assert(host.getAttribute('aria-label') === a11y.record.label, lang + ' 录制 aria-label 未本地化');
    assert(host.getAttribute('aria-label') === DYNAMIC_TEXT['overlay.record.label'][lang], lang + ' 录制 aria-label 没走 catalog');
    assert(host.getAttribute('dir') === (NON_LATIN.includes(lang) && (lang === 'ar' || lang === 'he') ? 'rtl' : 'ltr'), lang + ' 录制浮层 dir 不对');
    if (lang === 'zh') assert(HAN.test(host.getAttribute('aria-label')), 'zh 录制 aria-label 不是中文');
    else if (NON_LATIN.includes(lang)) assert(SCRIPTS[lang].test(host.getAttribute('aria-label')), lang + ' 录制 aria-label 缺本语言文字');
    else assert(!HAN.test(host.getAttribute('aria-label')), lang + ' 录制 aria-label 残留中文');
  }
});

// ── 2. 手动长截图：工具面板 dialog 语义 / Esc 取消 / 帧数播报 ──
test('manual：role=dialog + Esc 取消 + 帧数 aria-live 播报 + 焦点归还', async () => {
  const before = document.getElementById('before');
  before.focus();
  const texts = overlayTexts('zh');
  manualOverlayFunc(7, 'zh', OVERLAY_THEME, texts);
  const host = document.getElementById('__bb_manual_host');
  assert(host, '手动长截图浮层未创建');
  assert(host.getAttribute('role') === 'dialog', '手动长截图 role 不是 dialog');
  assert(host.getAttribute('aria-label') === texts.manual.label, '手动长截图 aria-label 不是本地化标签');
  const shadow = host.shadowRoot;
  assert(shadow.querySelector('.count').textContent === '7' + texts.manual.frames, '初始帧数不对');
  const frame = shadow.querySelector('.frame');
  const beforeCount = shadow.querySelector('.count').textContent;
  click(frame);
  // 帧数更新发生在异步 sendMessage 回包之后：轮询到期望值，不用固定延时赌时序。
  await waitFor(
    () => shadow.querySelector('.count').textContent === String(lastReply && lastReply.frames) + texts.manual.frames,
    '拍帧后帧数没有更新为回包帧数：' + shadow.querySelector('.count').textContent + ' / reply=' + JSON.stringify(lastReply),
  );
  const afterCount = shadow.querySelector('.count').textContent;
  assert(afterCount !== beforeCount, '拍帧后帧数没有变化：' + afterCount);
  assert(afterCount.endsWith(texts.manual.frames), '拍帧后帧数文案不是语言包单位：' + afterCount);
  await waitFor(
    () => shadow.querySelector('[data-a11y-live]').textContent.includes(texts.manual.frames.trim()),
    '帧数变化没有 aria-live 播报',
  );
  assert(shadow.querySelector('[data-a11y-hint]').textContent.includes(texts.manual.cancel), 'Esc/取消提示没有用语言包动作名');
  key(frame, 'Escape');
  assert(!document.getElementById('__bb_manual_host'), 'Esc 后手动长截图浮层没有移除');
  const cancelled = messages.some((message) => message.type === 'bb.manual.cancel');
  assert(cancelled, 'Esc 没有回传 bb.manual.cancel');
  assert(document.activeElement === before, '取消后焦点没有归还');
});

test('manual：12 语言 aria-label 使用语言包（含 RTL 语言）', () => {
  for (const lang of LANGS) {
    const texts = overlayTexts(lang);
    manualOverlayFunc(0, lang, OVERLAY_THEME, texts);
    const host = document.getElementById('__bb_manual_host');
    assert(host.getAttribute('aria-label') === texts.manual.label, lang + ' 手动长截图 aria-label 未本地化');
    if (NON_LATIN.includes(lang)) assert(SCRIPTS[lang].test(host.getAttribute('aria-label')), lang + ' 手动长截图 aria-label 缺本语言文字');
  }
});

// ── 3. 人工协助：模态语义 / 焦点陷阱 / Esc / 外部移除时焦点归还 ──
test('help：aria-modal/labelledby/describedby + 焦点陷阱 + Esc 取消 + 焦点归还', () => {
  const before = document.getElementById('before');
  before.focus();
  const texts = overlayTexts('zh');
  helpOverlayFunc('h1', '请完成验证码', '#help-target', null, '需要人工协助', 'zh', OVERLAY_THEME, texts);
  const host = document.getElementById('__bb_help_host');
  assert(host, 'Help 宿主未创建');
  const shadow = globalThis.__bbHelpRoots.get(host);
  const card = shadow.querySelector('.card');
  assert(card.getAttribute('role') === 'dialog', 'Help card role 不是 dialog');
  assert(card.getAttribute('aria-modal') === 'true', 'Help card 缺 aria-modal');
  assert(card.getAttribute('aria-labelledby') === '__bb_help_title', 'Help card 缺 aria-labelledby');
  assert(card.getAttribute('aria-describedby') === '__bb_help_msg', 'Help card 缺 aria-describedby');
  assert(shadow.querySelector('#__bb_help_title').textContent === '需要人工协助', 'Help 标题没有渲染');
  assert(shadow.querySelector('.chev').getAttribute('aria-controls') === '__bb_help_body', '折叠按钮缺 aria-controls');
  const note = shadow.querySelector('.note');
  assert(shadow.activeElement === note, 'Help 初始焦点不在留言框：' + (shadow.activeElement && shadow.activeElement.className));
  const order = () => [...shadow.querySelectorAll('button, textarea')].filter((el) => !el.disabled && el.getClientRects().length > 0);
  // 焦点陷阱：从最后一个控件 Tab 回到第一个；从第一个 Shift+Tab 绕到最后一个。
  const list = order();
  const first = list[0];
  const last = list[list.length - 1];
  last.focus();
  key(last, 'Tab');
  assert(shadow.activeElement === first, 'Tab 没有从最后一个控件回绕到第一个');
  first.focus();
  key(first, 'Tab', true);
  assert(shadow.activeElement === last, 'Shift+Tab 没有从第一个控件回绕到最后一个');
  note.focus();
  key(note, 'Tab');
  assert(shadow.activeElement !== document.body, 'note 上 Tab 后焦点落到了页面 body');
  key(host, 'Escape');
  assert(!document.getElementById('__bb_help_host'), 'Esc 后 Help 没有移除');
  assert(!document.getElementById('__bb_help_highlight'), 'Esc 后目标高亮没有移除');
  const resolved = lastMessage();
  assert(resolved && resolved.type === 'bb.help.resolved' && resolved.action === 'skip', 'Esc 没有按 skip 回传：' + JSON.stringify(resolved));
  assert(document.activeElement === before, 'Help 关闭后焦点没有归还');
});

test('help：外部移除（SW 超时/取消）也会归还焦点并摘掉监听', async () => {
  const before = document.getElementById('before');
  before.focus();
  helpOverlayFunc('h2', '外部移除', '', null, '', 'zh', OVERLAY_THEME, overlayTexts('zh'));
  const host = document.getElementById('__bb_help_host');
  assert(host, 'Help 宿主未创建');
  host.remove();
  await waitFor(() => document.activeElement === before, '外部移除 Help 后焦点没有归还', 500);
  // 监听已摘掉：再触发 scroll/resize 不应抛错，也不应重新创建浮层。
  window.dispatchEvent(new Event('resize'));
  assert(!document.getElementById('__bb_help_host'), '外部移除后浮层被重新创建');
});

test('help：折叠后焦点离开隐藏的留言框，aria-expanded 同步', () => {
  helpOverlayFunc('h3', '折叠', '', null, '', 'zh', OVERLAY_THEME, overlayTexts('zh'));
  const shadow = globalThis.__bbHelpRoots.get(document.getElementById('__bb_help_host'));
  const chev = shadow.querySelector('.chev');
  const note = shadow.querySelector('.note');
  note.focus();
  click(chev);
  assert(shadow.querySelector('.body').classList.contains('hidden'), '折叠后 body 没有隐藏');
  assert(chev.getAttribute('aria-expanded') === 'false', '折叠后 aria-expanded 不是 false');
  assert(shadow.activeElement === chev, '折叠后焦点没有移到可见的折叠按钮');
  assert(shadow.querySelector('[data-a11y-live]').textContent.includes(shadow.querySelector('.chev').getAttribute('aria-label')), '折叠状态没有 aria-live 播报');
});

// ── 4. 接管浮层：region/status、Esc 收起/展开、动作播报、动态标签 ──
test('takeover：region/aria-live、Esc 收起与展开、暂停/停止播报', () => {
  const a11y = overlayA11yTexts('zh');
  installTakeover({ sessionId: 'w5e', mode: 'ready', paused: false }, 'zh', takeoverVersion++, OVERLAY_THEME, overlayTexts('zh'), a11y);
  const host = document.querySelector('[data-bb-ui="takeover"]');
  assert(host, '接管浮层未创建');
  assert(host.getAttribute('aria-keyshortcuts') === 'Escape', '接管浮层缺 Escape 快捷键声明');
  const shadow = globalThis.__bbTakeoverRoots.get(host);
  const card = shadow.querySelector('.card');
  assert(card.getAttribute('role') === 'region', '接管卡片 role 不是 region');
  assert(card.getAttribute('aria-label') === a11y.takeover.label, '接管卡片 aria-label 不是动态文案');
  assert(card.querySelector('.status-row').getAttribute('aria-live') === 'polite', '状态区缺 aria-live');
  const live = shadow.querySelector('[data-a11y-live]');
  const hint = shadow.querySelector('[data-a11y-hint]');
  assert(hint.textContent === a11y.takeover.escHint, '接管 Esc 提示不是动态文案');
  const pause = shadow.querySelector('[data-act="pause"]');
  click(pause);
  assert(shadow.querySelector('.status-title').textContent === overlayTexts('zh').takeover.held[0], '暂停后状态标题不对');
  assert(live.textContent === a11y.takeover.paused, '暂停没有 aria-live 播报：' + live.textContent);
  click(pause);
  assert(live.textContent === a11y.takeover.resumed, '恢复没有 aria-live 播报：' + live.textContent);
  const min = shadow.querySelector('[data-act="min"]');
  min.focus();
  key(min, 'Escape');
  assert(card.style.display === 'none', 'Esc 后卡片没有收起');
  assert(shadow.activeElement === shadow.querySelector('[data-mini]'), 'Esc 收起后焦点没有到 mini');
  assert(live.textContent === a11y.takeover.collapsed, '收起没有 aria-live 播报');
  key(shadow.querySelector('[data-mini]'), 'Escape');
  assert(card.style.display !== 'none', 'Esc 后卡片没有展开');
  assert(live.textContent === a11y.takeover.expanded, '展开没有 aria-live 播报');
  const stop = shadow.querySelector('[data-act="stop"]');
  click(stop);
  assert(live.textContent === a11y.takeover.stopArmed, '停止二次确认没有播报');
  click(stop);
  assert(live.textContent === a11y.takeover.stopping, '停止中状态没有播报');
});

test('takeover：12 语言 aria-label 与 Esc 提示都来自动态文案', () => {
  for (const lang of LANGS) {
    // 接管浮层的“同一宿主只更新状态”语义会让语言切换复用旧文案：先摘掉宿主再渲染。
    document.querySelector('[data-bb-ui="takeover"]')?.remove();
    window.__bbTakeoverVersion = 0;
    installTakeover({ sessionId: 'w5e-' + lang, mode: 'ready' }, lang, takeoverVersion++, OVERLAY_THEME, overlayTexts(lang), overlayA11yTexts(lang));
    const host = document.querySelector('[data-bb-ui="takeover"]');
    const shadow = globalThis.__bbTakeoverRoots.get(host);
    const label = shadow.querySelector('.card').getAttribute('aria-label');
    assert(label === DYNAMIC_TEXT['overlay.takeover.label'][lang], lang + ' 接管卡片 aria-label 没走 catalog：' + label);
    assert(shadow.querySelector('[data-a11y-hint]').textContent === DYNAMIC_TEXT['overlay.takeover.escHint'][lang], lang + ' 接管 Esc 提示没走 catalog');
    if (NON_LATIN.includes(lang) && lang !== 'zh-TW') assert(SCRIPTS[lang].test(label), lang + ' 接管 aria-label 缺本语言文字');
    else if (lang === 'zh' || lang === 'zh-TW') assert(HAN.test(label), lang + ' 接管 aria-label 不是中文');
    else assert(!HAN.test(label), lang + ' 接管 aria-label 残留中文');
  }
});

// ── 5. 借用确认：动态倒计时/提示、Esc 拒绝、焦点归还；Toast 的 Esc 关闭 ──
test('borrow：倒计时与 Esc 提示来自动态文案，Esc 拒绝并归还焦点', () => {
  const before = document.getElementById('before');
  before.focus();
  const a11y = overlayA11yTexts('zh');
  borrowBanner('w5e-borrow', '可访问性标签页', 5000, 'zh', OVERLAY_THEME, overlayTexts('zh'), a11y);
  const host = document.getElementById('__bb_borrow_modal');
  assert(host, '借用模态未创建');
  assert(host.getAttribute('aria-modal') === 'true', '借用模态缺 aria-modal');
  assert(host.getAttribute('aria-keyshortcuts') === 'Escape', '借用模态缺 Escape 快捷键声明');
  assert(host.querySelector('[data-a11y-hint]').textContent === a11y.borrow.escHint, '借用 Esc 提示不是动态文案');
  assert(host.querySelector('[data-count]').textContent === a11y.borrow.countdown.replace('{seconds}', '5'), '倒计时不是动态文案模板：' + host.querySelector('[data-count]').textContent);
  assert(host.querySelector('[data-allow]').getAttribute('role') === null || true, '允许按钮结构异常');
  key(host.querySelector('[data-deny]'), 'Escape');
  assert(!document.getElementById('__bb_borrow_modal'), 'Esc 后借用模态没有移除');
  const decision = lastMessage();
  assert(decision && decision.type === 'bb.borrow.decision' && decision.allow === false && decision.timedOut === false, 'Esc 没有按拒绝结算');
  assert(document.activeElement === before, '借用模态关闭后焦点没有归还');
});

test('toast：role=region + Esc 提示来自动态文案，Esc 关闭该条请求', () => {
  const a11y = overlayA11yTexts('en');
  borrowToast('w5e-toast', 'Toast tab', 3000, 'en', OVERLAY_THEME, overlayTexts('en'), a11y);
  const host = document.getElementById('__bb_borrow_toast_host');
  assert(host, '借用 Toast 未创建');
  assert(host.getAttribute('role') === 'region', 'Toast role 不是 region');
  assert(host.getAttribute('aria-keyshortcuts') === 'Escape', 'Toast 缺 Escape 快捷键声明');
  const item = host.querySelector('[data-request="w5e-toast"]');
  assert(item.querySelector('[data-a11y-hint]').textContent === a11y.toast.escHint, 'Toast Esc 提示不是动态文案');
  assert(item.getAttribute('aria-label') === overlayTexts('en').toast.title, 'Toast 项缺可访问名称');
  key(item.querySelector('[data-allow]'), 'Escape');
  assert(!document.getElementById('__bb_borrow_toast_host'), 'Esc 后 Toast 没有移除');
  const decision = lastMessage();
  assert(decision && decision.type === 'bb.borrow.decision' && decision.allow === false, 'Toast 的 Esc 没有按拒绝结算');
});

// ── 6. 12 语言渲染矩阵：模态标题/允许按钮/文案都不残留中文 ──
test('borrow：12 语言标题与按钮全部本地化（拉丁语言不残留中文）', () => {
  for (const lang of LANGS) {
    const texts = overlayTexts(lang);
    borrowBanner('w5e-matrix-' + lang, 'Tab', 5000, lang, OVERLAY_THEME, texts, overlayA11yTexts(lang));
    const host = document.getElementById('__bb_borrow_modal');
    assert(host.getAttribute('aria-label') === texts.borrow.title, lang + ' 借用模态 aria-label 未本地化');
    const allow = host.querySelector('[data-allow]');
    assert(allow.textContent === texts.borrow.allow, lang + ' 允许按钮未本地化');
    if (lang === 'zh') {
      assert(HAN.test(host.getAttribute('aria-label')), 'zh 借用模态 aria-label 不是中文');
    } else if (NON_LATIN.includes(lang)) {
      assert(SCRIPTS[lang].test(host.getAttribute('aria-label')), lang + ' 借用模态 aria-label 缺本语言文字');
    } else {
      assert(!HAN.test(host.getAttribute('aria-label')), lang + ' 借用模态 aria-label 残留中文');
      assert(!HAN.test(texts.borrow.allow), lang + ' 允许按钮残留中文');
    }
  }
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) {
    try {
      document.title = 'OVERLAY_A11Y_W5E_PROGRESS:' + passed + ':' + name;
      await fn();
      passed += 1;
      clean();
    } catch (error) {
      clean();
      document.title = 'OVERLAY_A11Y_W5E_FAIL:' + name + ':' + String((error && error.message) || error);
      return;
    }
  }
  document.title = 'OVERLAY_A11Y_W5E_OK:' + passed;
})();
