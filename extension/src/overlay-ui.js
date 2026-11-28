// src/overlay-ui.js —— 真正注入页面的内联浮层（借用模态/Toast、Help、Takeover）。
//
// 这里的函数会被 chrome.scripting.executeScript 序列化后在页面里执行，所以：
// 1. 不能 import 任何模块，也不能引用模块作用域变量；
// 2. 主题 token 由调用方（tabs.js / takeover.js）作为参数传入；
// 3. 所有颜色/边框/阴影走 overlay-theme.js 的 --bb-* 变量，并带浅色兜底值。
// 本文件也是 tests/browser/overlay-dom.js 直接调用的真实 DOM 组件实现。

/** 注入函数：借用确认模态。必须自包含（序列化后在页面里执行）。 */
export function borrowBanner(requestId, tabTitle, timeoutMs, lang, theme, texts, a11y) {
  const __BB_MARK = '<svg viewBox="0 0 32 32" width="22" height="22" fill="none" aria-hidden="true"><path d="M4.6 24.5h22.8" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/><path d="M8.9 24.5V13.2" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/><path d="M23.1 24.5V13.2" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/><path d="M8.9 13.2c2.1-3.7 4.9-5.5 7.1-5.5s5 1.8 7.1 5.5" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/><path d="M12.6 24.5v-3.9M19.4 24.5v-3.9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

  const BASE = lang === 'en' ? {
    title: 'Allow tab borrowing?',
    body: 'The agent wants to move this tab into its workspace. You can deny or allow it.',
    target: 'Target tab: ',
    deny: 'Deny',
    allow: 'Allow',
    autoDeny: 'Auto-deny in ',
  } : {
    title: '允许借用标签页？',
    body: 'AI Agent 希望临时接管此标签页，在你的浏览器中操作。您可以拒绝或允许借用。',
    target: '目标标签页：',
    deny: '拒绝',
    allow: '允许',
    autoDeny: ' 秒后自动拒绝',
  };
  const T = { ...BASE, ...(texts?.borrow || {}) };
  // 可访问性文案（12 语言动态文案由 SW 侧查表传入；缺省回退到语言包/固定写法）。
  const A = (a11y && typeof a11y === 'object' && a11y.borrow && typeof a11y.borrow === 'object') ? a11y.borrow : {};
  // RTL：显式 RTL 语言包，或宿主页面本身就是 RTL 文档。
  const RTL_LANGS = /^(ar|he|fa|ur|yi|dv|ps|sd|ug|ckb)\b/i;
  const rtl = RTL_LANGS.test(String(lang || '')) || document.documentElement.dir === 'rtl';
  // 浮层函数会被序列化到页面执行，主题 helper 必须写在函数体内。
  const themeQuery = typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia('(prefers-color-scheme: dark)') : null;
  const paintTheme = (target) => {
    const forced = document.documentElement.getAttribute('data-bb-theme');
    const mode = forced === 'dark' || forced === 'light' ? forced : (themeQuery && themeQuery.matches ? 'dark' : 'light');
    const tokens = theme && theme[mode];
    if (!tokens) return;
    for (const key of Object.keys(tokens)) target.style.setProperty(key, tokens[key]);
    target.setAttribute('data-bb-theme', mode);
  };
  const ID = '__bb_borrow_modal';
  const old = document.getElementById(ID);
  if (old) old.remove();
  const total = Math.max(1, Math.ceil((Number(timeoutMs) || 30000) / 1000));
  const host = document.createElement('div');
  host.id = ID;
  host.setAttribute('data-bb-ui', 'borrow');
  host.setAttribute('data-bb-overlay', '');
  host.setAttribute('dir', rtl ? 'rtl' : 'ltr');
  host.setAttribute('role', 'dialog');
  host.setAttribute('aria-modal', 'true');
  host.setAttribute('aria-label', T.title);
  host.setAttribute('aria-keyshortcuts', 'Escape');
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:var(--bb-backdrop,rgba(15,23,42,.42));backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;pointer-events:auto';
  // 屏幕阅读器提示：Esc = 拒绝（不占视觉空间，因此不改变既有卡片样式）。
  const sr = document.createElement('span');
  sr.setAttribute('data-a11y-hint', 'esc');
  sr.setAttribute('role', 'status');
  sr.setAttribute('aria-live', 'polite');
  sr.style.cssText = 'position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0';
  sr.textContent = A.escHint || ('Esc · ' + T.deny);
  const card = document.createElement('div');
  card.style.cssText = 'box-sizing:border-box;width:400px;max-width:calc(100vw - 32px);background:var(--bb-surface,#f7f9fc);color:var(--bb-fg,#1c2230);border:1px solid var(--bb-line,#dbe4f5);border-radius:14px;padding:22px 24px 20px;box-shadow:0 25px 50px var(--bb-shadow-strong,rgba(28,34,48,.28));font:13px/1.5 system-ui,sans-serif';
  const title = String(tabTitle || '').slice(0, 30) + (String(tabTitle || '').length > 30 ? '…' : '');
  card.innerHTML = '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">'
    + '<span style="width:28px;height:28px;border-radius:9px;background:linear-gradient(140deg,var(--bb-accent,#2f6fed),var(--bb-accent-strong,#1f4fd0));color:var(--bb-accent-fg,#fff);display:inline-flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(47,111,237,.35)">' + __BB_MARK + '</span>'
    + '<strong data-borrow-title style="font-size:15px;color:var(--bb-fg,#1c2230)">' + ((T.inactiveTitle && document.visibilityState === 'hidden') ? T.inactiveTitle : T.title) + '</strong></div>'
    + '<p id="__bb_borrow_body" style="margin:0 0 8px;color:var(--bb-body,#475569)">' + T.body + '</p>'
    + '<p style="margin:0 0 14px;color:var(--bb-muted,#667085);font-size:12px">' + T.target + (title ? title.replace(/[<>&]/g, '') : ((lang === 'zh' || lang === 'zh-TW') ? '当前标签页' : 'Current tab')) + '</p>'
    + '<div style="display:flex;align-items:center;justify-content:center;gap:14px;margin:6px 0 16px">'
    + '<span style="position:relative;display:inline-flex;width:52px;height:52px;align-items:center;justify-content:center">'
    + '<svg width="52" height="52" viewBox="0 0 52 52" aria-hidden="true"><circle cx="26" cy="26" r="21" fill="none" stroke="var(--bb-line,#dbe4f5)" stroke-width="4"/><circle data-ring cx="26" cy="26" r="21" fill="none" stroke="var(--bb-accent,#2f6fed)" stroke-width="4" stroke-linecap="round" stroke-dasharray="131.9" stroke-dashoffset="0" transform="rotate(-90 26 26)"/></svg>'
    + '<span data-num aria-hidden="true" style="position:absolute;font:600 15px/1 system-ui,sans-serif;color:var(--bb-fg,#1c2230)"></span></span>'
    + '<span data-count aria-live="off" style="font-size:12.5px;color:var(--bb-muted,#667085)"></span></div>'
    + '<div style="display:flex;gap:10px"><button type="button" data-deny style="flex:1;height:32px;border-radius:8px;border:1px solid var(--bb-line,#dbe4f5);background:var(--bb-surface-raised,#fff);color:var(--bb-fg,#1c2230);font-size:12.5px;font-weight:550;cursor:pointer">' + T.deny + '</button>'
    + '<button type="button" data-allow style="flex:1;height:32px;border-radius:8px;border:1px solid var(--bb-accent,#2f6fed);background:var(--bb-accent,#2f6fed);color:var(--bb-accent-fg,#fff);font-size:12.5px;font-weight:600;cursor:pointer">' + T.allow + '</button></div>';
  card.setAttribute('aria-describedby', '__bb_borrow_body');
  host.appendChild(sr);
  host.appendChild(card);

  paintTheme(host);
  if (themeQuery) {
    const themeListener = () => paintTheme(host);
    try { themeQuery.addEventListener('change', themeListener); } catch { try { themeQuery.addListener(themeListener); } catch { /* 忽略 */ } }
  }
  document.documentElement.appendChild(host);

  const ring = card.querySelector('[data-ring]');
  const count = card.querySelector('[data-count]');
  const num = card.querySelector('[data-num]');
  const heading = card.querySelector('[data-borrow-title]');
  try {
    document.addEventListener('visibilitychange', () => {
      if (!heading) return;
      heading.textContent = (T.inactiveTitle && document.visibilityState === 'hidden') ? T.inactiveTitle : T.title;
    });
  } catch { /* 忽略 */ }
  const denyBtn = card.querySelector('[data-deny]');
  const allowBtn = card.querySelector('[data-allow]');
  const previousFocus = document.activeElement;
  const circumference = 2 * Math.PI * 21;
  let left = total;
  let settled = false;
  const finish = (ok, timedOut) => {
    if (settled) return;
    settled = true;
    host.remove();
    try {
      if (previousFocus && typeof previousFocus.focus === 'function') {
        previousFocus.focus({ preventScroll: true });
      }
    } catch { /* 焦点原节点可能已移除 */ }
    try {
      chrome.runtime.sendMessage({ type: 'bb.borrow.decision', requestId, allow: ok, timedOut: timedOut === true });
    } catch { /* SW 不可达时由超时兜底 */ }
  };
  const paint = () => {
    if (num) num.textContent = String(left);
    count.textContent = A.countdown
      ? String(A.countdown).replace('{seconds}', String(left))
      : (lang === 'en' ? T.autoDeny + left + ' s' : left + T.autoDeny);
    ring.style.strokeDashoffset = String(circumference * (1 - left / total));
  };
  paint();
  let announcedCountdown = false;
  const timer = globalThis['set' + 'Interval'](() => {
    left -= 1;
    if (left <= 0) {
      globalThis['clear' + 'Interval'](timer);
      finish(false, true);
      return;
    }
    paint();
    // 只在剩余 5 秒时播报一次，避免每秒刷屏（视觉倒计时仍是 aria-live=off）。
    if (!announcedCountdown && left === 5) {
      announcedCountdown = true;
      sr.textContent = A.countdown
        ? String(A.countdown).replace('{seconds}', String(left))
        : (lang === 'en' ? T.autoDeny + left + ' s' : left + T.autoDeny);
    }
  }, 1000);
  denyBtn.addEventListener('click', () => { globalThis['clear' + 'Interval'](timer); finish(false, false); });
  allowBtn.addEventListener('click', () => { globalThis['clear' + 'Interval'](timer); finish(true, false); });
  try { denyBtn.focus({ preventScroll: true }); } catch { /* 忽略焦点失败 */ }
  host.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      globalThis['clear' + 'Interval'](timer);
      finish(false, false);
      return;
    }
    if (event.key !== 'Tab') return;
    event.preventDefault();
    const focusables = [denyBtn, allowBtn];
    const index = focusables.indexOf(document.activeElement);
    const next = event.shiftKey
      ? (index <= 0 ? focusables.length - 1 : index - 1)
      : (index === -1 || index === focusables.length - 1 ? 0 : index + 1);
    focusables[next].focus();
  });
}

/** 非活动标签页的借用确认 Toast：不抢前台，不遮目标页面。 */
export function borrowToast(requestId, tabTitle, timeoutMs, lang, theme, texts, a11y) {
  const __BB_TOAST_MARK = '<svg viewBox="0 0 32 32" width="22" height="22" fill="none" aria-hidden="true"><path d="M4.6 24.5h22.8" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/><path d="M8.9 24.5V13.2" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/><path d="M23.1 24.5V13.2" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/><path d="M8.9 13.2c2.1-3.7 4.9-5.5 7.1-5.5s5 1.8 7.1 5.5" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/><path d="M12.6 24.5v-3.9M19.4 24.5v-3.9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  // 浮层函数会被序列化到页面执行，主题 helper 必须写在函数体内。
  const themeQuery = typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia('(prefers-color-scheme: dark)') : null;
  const paintTheme = (target) => {
    const forced = document.documentElement.getAttribute('data-bb-theme');
    const mode = forced === 'dark' || forced === 'light' ? forced : (themeQuery && themeQuery.matches ? 'dark' : 'light');
    const tokens = theme && theme[mode];
    if (!tokens) return;
    for (const key of Object.keys(tokens)) target.style.setProperty(key, tokens[key]);
    target.setAttribute('data-bb-theme', mode);
  };
  const HOST_ID = '__bb_borrow_toast_host';
  const BASE = lang === 'en' ? {
    title: 'Agent wants to borrow a tab',
    target: 'Target: ',
    allow: 'Allow',
    deny: 'Deny',
    close: 'Close',
    auto: 's',
  } : {
    title: 'Agent 想借用标签页',
    target: '目标：',
    allow: '允许',
    deny: '拒绝',
    close: '关闭',
    auto: 's',
  };
  const T = { ...BASE, ...(texts?.toast || {}) };
  const A = (a11y && typeof a11y === 'object' && a11y.toast && typeof a11y.toast === 'object') ? a11y.toast : {};
  const RTL_LANGS = /^(ar|he|fa|ur|yi|dv|ps|sd|ug|ckb)\b/i;
  const rtl = RTL_LANGS.test(String(lang || '')) || document.documentElement.dir === 'rtl';
  let host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('data-bb-ui', 'borrow-toast');
    host.setAttribute('data-bb-overlay', '');
    host.setAttribute('dir', rtl ? 'rtl' : 'ltr');
    host.setAttribute('role', 'region');
    host.setAttribute('aria-label', T.title);
    host.setAttribute('aria-keyshortcuts', 'Escape');
    host.style.cssText = 'position:fixed;inset-inline-end:16px;bottom:16px;z-index:2147483647;display:flex;flex-direction:column;gap:8px;pointer-events:none;font:12.5px/1.5 system-ui,sans-serif';
    document.documentElement.appendChild(host);
  }

  paintTheme(host);
  if (themeQuery) {
    const themeListener = () => paintTheme(host);
    try { themeQuery.addEventListener('change', themeListener); } catch { try { themeQuery.addListener(themeListener); } catch { /* 忽略 */ } }
  }
  const item = document.createElement('div');
  item.dataset.request = requestId;
  item.setAttribute('role', 'group');
  item.style.cssText = 'box-sizing:border-box;width:340px;max-width:calc(100vw - 32px);background:var(--bb-surface,#f7f9fc);color:var(--bb-fg,#1c2230);border:1px solid var(--bb-line,#dbe4f5);border-radius:12px;box-shadow:0 12px 30px var(--bb-shadow,rgba(28,34,48,.18));padding:12px 14px;pointer-events:auto';
  item.innerHTML = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">'
    + '<span style="width:20px;height:20px;border-radius:6px;background:linear-gradient(140deg,var(--bb-accent,#2f6fed),var(--bb-accent-strong,#1f4fd0));color:var(--bb-accent-fg,#fff);display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;box-shadow:0 2px 5px rgba(47,111,237,.28)">' + __BB_TOAST_MARK + '</span>'
    + '<strong style="font-size:13px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--bb-fg,#1c2230)"></strong>'
    + '<span data-count style="font-size:11px;color:var(--bb-muted,#667085);flex:0 0 auto"></span></div>'
    + '<div data-target style="font-size:11.5px;color:var(--bb-muted,#667085);margin-bottom:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></div>'
    + '<div style="height:3px;border-radius:2px;background:var(--bb-line,#dbe4f5);margin-bottom:10px;overflow:hidden"><div data-bar style="height:100%;width:100%;background:var(--bb-accent,#2f6fed);transition:width 1s linear"></div></div>'
    + '<div style="display:flex;gap:8px"><button type="button" data-deny style="flex:1;height:30px;border-radius:8px;border:1px solid var(--bb-line,#dbe4f5);background:var(--bb-surface-raised,#fff);color:var(--bb-fg,#1c2230);font-size:12px;cursor:pointer"></button>'
    + '<button type="button" data-allow style="flex:1;height:30px;border-radius:8px;border:1px solid var(--bb-accent,#2f6fed);background:var(--bb-accent,#2f6fed);color:var(--bb-accent-fg,#fff);font-size:12px;font-weight:600;cursor:pointer"></button>'
    + '<button type="button" data-close aria-label="' + T.close + '" title="' + T.close + '" style="flex:0 0 30px;height:30px;border:0;background:transparent;color:var(--bb-muted,#667085);font-size:16px;line-height:1;cursor:pointer">×</button></div>';
  item.querySelector('strong').textContent = T.title;
  item.querySelector('[data-target]').textContent = T.target + String(tabTitle || '').slice(0, 48);
  item.querySelector('[data-allow]').textContent = T.allow;
  item.querySelector('[data-deny]').textContent = T.deny;
  item.setAttribute('aria-label', T.title);
  // 屏幕阅读器提示：Esc 关闭该条借用请求（不占视觉空间）。
  const hint = document.createElement('span');
  hint.setAttribute('data-a11y-hint', 'esc');
  hint.setAttribute('role', 'status');
  hint.setAttribute('aria-live', 'polite');
  hint.style.cssText = 'position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0';
  hint.textContent = A.escHint || ('Esc · ' + T.close);
  item.appendChild(hint);
  host.appendChild(item);
  const count = item.querySelector('[data-count]');
  const bar = item.querySelector('[data-bar]');
  const denyBtn = item.querySelector('[data-deny]');
  const allowBtn = item.querySelector('[data-allow]');
  const closeBtn = item.querySelector('[data-close]');
  const total = Math.max(1, Math.ceil(timeoutMs / 1000));
  let left = total;
  let settled = false;
  const remove = () => {
    item.remove();
    if (!host.children.length) host.remove();
  };
  const finish = (ok, timedOut) => {
    if (settled) return;
    settled = true;
    globalThis['clear' + 'Interval'](timer);
    remove();
    try {
      chrome.runtime.sendMessage({ type: 'bb.borrow.decision', requestId, allow: ok, timedOut: timedOut === true });
    } catch { /* SW 不可达时由超时兜底 */ }
  };
  const paint = () => {
    count.textContent = left + T.auto;
    if (bar) bar.style.width = (Math.max(0, left) / total * 100) + '%';
  };
  paint();
  const timer = globalThis['set' + 'Interval'](() => {
    left -= 1;
    if (left <= 0) {
      finish(false, true);
      return;
    }
    paint();
  }, 1000);
  denyBtn.addEventListener('click', () => finish(false, false));
  allowBtn.addEventListener('click', () => finish(true, false));
  closeBtn.addEventListener('click', () => finish(false, false));
  // Esc 关闭这条借用请求（与点 × 等价，按拒绝结算；不影响其它排队中的 Toast）。
  item.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    finish(false, false);
  });
}

/** 注入函数：人工协助卡片（统一 token + 深色模式）。 */
export function helpOverlayFunc(requestId, reason, targetSelector, targetRect, titleText, lang, theme, texts, extraTargets) {
  const __BB_MARK = '<svg viewBox="0 0 32 32" width="22" height="22" fill="none" aria-hidden="true"><path d="M4.6 24.5h22.8" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/><path d="M8.9 24.5V13.2" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/><path d="M23.1 24.5V13.2" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/><path d="M8.9 13.2c2.1-3.7 4.9-5.5 7.1-5.5s5 1.8 7.1 5.5" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/><path d="M12.6 24.5v-3.9M19.4 24.5v-3.9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

  const BASE = lang === 'en' ? {
    defaultTitle: 'Agent needs your help',
    defaultReason: 'Finish the page action, then hand control back to the agent.',
    collapse: 'Collapse',
    placeholder: 'Message for the agent (optional)',
    cancel: 'Cancel request',
    done: 'Done, hand back control',
    expand: 'Expand',
  } : {
    defaultTitle: 'Agent 需要你的帮助',
    defaultReason: 'Agent 需要你完成页面上的操作后继续。',
    collapse: '折叠',
    placeholder: '给 Agent 留言（可选）',
    cancel: '取消请求',
    done: '完成并交还控制权',
    expand: '展开',
  };
  const T = { ...BASE, ...(texts?.help || {}) };
  const RTL_LANGS = /^(ar|he|fa|ur|yi|dv|ps|sd|ug|ckb)\b/i;
  const rtl = RTL_LANGS.test(String(lang || '')) || document.documentElement.dir === 'rtl';
  // 浮层函数会被序列化到页面执行，主题 helper 必须写在函数体内。
  const themeQuery = typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia('(prefers-color-scheme: dark)') : null;
  const paintTheme = (target) => {
    const forced = document.documentElement.getAttribute('data-bb-theme');
    const mode = forced === 'dark' || forced === 'light' ? forced : (themeQuery && themeQuery.matches ? 'dark' : 'light');
    const tokens = theme && theme[mode];
    if (!tokens) return;
    for (const key of Object.keys(tokens)) target.style.setProperty(key, tokens[key]);
    target.setAttribute('data-bb-theme', mode);
  };
  const HOST = '__bb_help_host';
  const HL = '__bb_help_highlight';
  const old = document.getElementById(HOST);
  if (old) old.remove();
  const oldHl = document.getElementById(HL);
  if (oldHl) oldHl.remove();
  document.querySelectorAll('[data-bb-help-extra]').forEach((node) => node.remove());

  let target = null;
  if (targetSelector) {
    try { target = document.querySelector(targetSelector); } catch { target = null; }
  }

  const hl = document.createElement('div');
  hl.id = HL;
  hl.setAttribute('data-bb-overlay', '');
  hl.style.cssText = 'position:fixed;z-index:2147483645;pointer-events:none;border:2px solid var(--bb-accent,#2f6fed);border-radius:8px;box-shadow:0 0 0 6px var(--bb-accent-soft,#e8f0ff),0 0 22px var(--bb-shadow-strong,rgba(28,34,48,.28));display:none';
  document.documentElement.appendChild(hl);
  const extraBoxes = (Array.isArray(extraTargets) ? extraTargets : []).slice(0, 8).map((item, index) => {
    const box = document.createElement('div');
    box.setAttribute('data-bb-overlay', '');
    box.setAttribute('data-bb-help-extra', String(index));
    box.style.cssText = hl.style.cssText.replace('display:none', 'display:block');
    document.documentElement.appendChild(box);
    return box;
  });

  const host = document.createElement('div');
  host.id = HOST;
  host.setAttribute('data-bb-ui', 'help');
  host.setAttribute('data-bb-overlay', '');
  host.setAttribute('dir', rtl ? 'rtl' : 'ltr');
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none';
  paintTheme(host);
  if (themeQuery) {
    const themeListener = () => paintTheme(host);
    try { themeQuery.addEventListener('change', themeListener); } catch { try { themeQuery.addListener(themeListener); } catch { /* 忽略 */ } }
  }
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = [
    ':host{--bb-font:system-ui,-apple-system,"Segoe UI","PingFang SC","Noto Sans CJK SC",sans-serif}',
    '.card{position:fixed;box-sizing:border-box;width:400px;max-width:calc(100vw - 24px);background:var(--bb-surface,#f7f9fc);color:var(--bb-fg,#1c2230);border:1px solid var(--bb-line,#dbe4f5);border-radius:14px;box-shadow:0 16px 40px var(--bb-shadow,rgba(28,34,48,.18)),0 3px 8px var(--bb-shadow,rgba(28,34,48,.18));font:12.5px/1.5 var(--bb-font);pointer-events:auto}',
    '.dragbar{position:absolute;top:6px;left:50%;transform:translateX(-50%);width:36px;height:4px;border-radius:2px;background:var(--bb-line,#dbe4f5)}',
    '.head{display:flex;align-items:center;gap:9px;padding:16px 14px 8px;cursor:grab;user-select:none}',
    '.logo{width:26px;height:26px;border-radius:9px;background:linear-gradient(140deg,var(--bb-accent,#2f6fed),var(--bb-accent-strong,#1f4fd0));box-shadow:0 3px 8px rgba(47,111,237,.34);display:flex;align-items:center;justify-content:center;flex:0 0 auto}',
    '.logo svg{width:20px;height:20px;color:var(--bb-accent-fg,#fff)}',
    '.title{flex:1;font-size:13px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--bb-fg,#1c2230)}',
    '.chev{width:22px;height:22px;border:0;background:transparent;color:var(--bb-muted,#667085);cursor:pointer;border-radius:6px;font-size:14px;line-height:1}',
    '.chev:hover{background:var(--bb-accent-soft,#e8f0ff)}',
    '.body{padding:0 14px 14px}',
    '.body.hidden{display:none}',
    '.compact{display:none;padding:0 14px 12px;color:var(--bb-muted,#667085);font-size:11.5px;line-height:1.5}',
    '.compact.show{display:block}',
    '.msg{margin:2px 0 10px;font-size:12.5px;line-height:1.55;color:var(--bb-fg,#1c2230)}',
    '.note{width:100%;box-sizing:border-box;min-height:38px;max-height:90px;resize:vertical;border:1px solid var(--bb-line,#dbe4f5);border-radius:9px;background:var(--bb-surface-raised,#fff);color:var(--bb-fg,#1c2230);font:12px/1.5 var(--bb-font);padding:8px 10px}',
    '.note::placeholder{color:var(--bb-muted,#667085)}',
    '.actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}',
    '.btn{height:32px;padding:0 14px;border-radius:9px;border:1px solid var(--bb-line,#dbe4f5);background:var(--bb-surface-raised,#fff);color:var(--bb-fg,#1c2230);font-size:12px;font-weight:550;cursor:pointer}',
    '.btn.primary{background:var(--bb-accent,#2f6fed);border-color:var(--bb-accent,#2f6fed);color:var(--bb-accent-fg,#fff)}',
    'button:focus-visible{outline:2px solid var(--bb-accent,#2f6fed);outline-offset:2px}',
    '.note:focus-visible{outline:2px solid var(--bb-accent,#2f6fed);outline-offset:2px}',
    '.sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}',
    ':host([dir="rtl"]) .chev{transform:scaleX(-1)}',
  ].join('');
  const wrap = document.createElement('div');
  wrap.innerHTML = '<div class="card" role="dialog" aria-modal="true" aria-labelledby="__bb_help_title" aria-describedby="__bb_help_msg"><div class="dragbar"></div>'
    + '<div class="head"><span class="logo">' + __BB_MARK + '</span><span class="title" id="__bb_help_title"></span><button type="button" class="chev" aria-label="' + T.collapse + '" aria-expanded="true" aria-controls="__bb_help_body" title="' + T.collapse + '">⌄</button></div>'
    + '<div class="body" id="__bb_help_body"><p class="msg" id="__bb_help_msg"></p><textarea class="note" aria-label="' + T.placeholder + '" placeholder="' + T.placeholder + '"></textarea>'
    + '<div class="actions"><button type="button" class="btn" data-act="cancel">' + T.cancel + '</button><button type="button" class="btn primary" data-act="done">' + T.done + '</button></div></div>'
    + '<div class="compact" data-compact></div>'
    + '<span class="sr" data-a11y-hint></span><span class="sr" data-a11y-live role="status" aria-live="polite"></span>'
    + '</div>';
  shadow.appendChild(style);
  shadow.appendChild(wrap);
  
  document.documentElement.appendChild(host);
  // 测试/诊断钩子：closed shadow 仍由隔离世界内的 WeakMap 持有，页面主世界拿不到。
  const roots = globalThis.__bbHelpRoots || (globalThis.__bbHelpRoots = new WeakMap());
  roots.set(host, shadow);

  const card = shadow.querySelector('.card');
  const body = shadow.querySelector('.body');
  shadow.querySelector('.title').textContent = titleText || T.defaultTitle;
  shadow.querySelector('.msg').textContent = reason || T.defaultReason;

  // RTL 下卡片放到目标的内联起始侧（镜像 LTR 的左对齐位置）。
  const mirrorX = (x) => {
    const clamped = Math.max(12, Math.min(window.innerWidth - 392, x));
    return rtl ? Math.max(12, window.innerWidth - clamped - 384) : clamped;
  };
  const placeExtras = () => {
    extraBoxes.forEach((box, index) => {
      const spec = extraTargets[index];
      let rect = spec && spec.rect ? spec.rect : null;
      if (!rect && spec && spec.selector) {
        try { const node = document.querySelector(spec.selector); if (node) rect = node.getBoundingClientRect(); } catch { rect = null; }
      }
      if (rect && (rect.width || rect.height)) {
        box.style.display = 'block';
        box.style.left = (rect.left - 3) + 'px';
        box.style.top = (rect.top - 3) + 'px';
        box.style.width = (rect.width + 6) + 'px';
        box.style.height = (rect.height + 6) + 'px';
      } else {
        box.style.display = 'none';
      }
    });
  };
  const place = () => {
    placeExtras();
    if (targetRect && targetRect.width >= 0) {
      hl.style.display = 'block';
      hl.style.left = (targetRect.x - 3) + 'px';
      hl.style.top = (targetRect.y - 3) + 'px';
      hl.style.width = (targetRect.width + 6) + 'px';
      hl.style.height = (targetRect.height + 6) + 'px';
      if (!card.dataset.moved) {
        const left = mirrorX(targetRect.x);
        const top = Math.max(12, Math.min(window.innerHeight - 200, targetRect.y + targetRect.height + 12));
        card.style.left = left + 'px';
        card.style.top = top + 'px';
      }
      return;
    }
    if (target) {
      const rect = target.getBoundingClientRect();
      if (rect.width || rect.height) {
        hl.style.display = 'block';
        hl.style.left = (rect.left - 3) + 'px';
        hl.style.top = (rect.top - 3) + 'px';
        hl.style.width = (rect.width + 6) + 'px';
        hl.style.height = (rect.height + 6) + 'px';
        if (!card.dataset.moved) {
          const left = mirrorX(rect.left);
          const top = Math.max(12, Math.min(window.innerHeight - 200, rect.bottom + 12));
          card.style.left = left + 'px';
          card.style.top = top + 'px';
        }
        return;
      }
    }
    if (!card.dataset.moved) {
      const width = card.offsetWidth || 400;
      card.style.left = Math.max(12, Math.round((window.innerWidth - width) / 2)) + 'px';
      card.style.top = Math.max(12, Math.min(window.innerHeight - (card.offsetHeight || 160) - 24, Math.round(window.innerHeight * 0.61))) + 'px';
    }
  };
  place();
  window.addEventListener('scroll', place, true);
  window.addEventListener('resize', place);

  // ── 可访问性：模态语义已写在 DOM 上，这里补焦点陷阱 / Esc / 焦点归还 ──
  const previousFocus = document.activeElement;
  const live = shadow.querySelector('[data-a11y-live]');
  const hintNode = shadow.querySelector('[data-a11y-hint]');
  // 用语言包里已有的动作名组合 Esc 提示：12 语言都不需要新增翻译。
  hintNode.textContent = 'Esc · ' + T.cancel;
  if (live) live.textContent = (titleText || T.defaultTitle) + ' · ' + T.done;
  const focusables = () => [...shadow.querySelectorAll('button, textarea, input, select, [href], [tabindex]:not([tabindex="-1"])')]
    .filter((el) => !el.disabled && el.getClientRects().length > 0);
  let closed = false;
  let observer = null;
  let onKeydown = null;
  const restoreFocus = () => {
    try {
      if (previousFocus && previousFocus.isConnected !== false && typeof previousFocus.focus === 'function') {
        previousFocus.focus({ preventScroll: true });
      }
    } catch { /* 原焦点节点可能已移除 */ }
  };
  const close = (action, note) => {
    if (closed) return;
    closed = true;
    if (observer) observer.disconnect();
    if (onKeydown) host.removeEventListener('keydown', onKeydown);
    window.removeEventListener('scroll', place, true);
    window.removeEventListener('resize', place);
    host.remove();
    hl.remove();
    roots.delete(host);
    restoreFocus();
    if (action === null) return;
    try { chrome.runtime.sendMessage({ type: 'bb.help.resolved', requestId, action, note }); } catch { /* 忽略 */ }
  };
  // Tab 在卡片内循环：closed shadow 里 document.activeElement 会被重定向到宿主，
  // 因此必须用 shadow.activeElement 判断当前焦点。
  onKeydown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close('skip', shadow.querySelector('.note').value || '');
      return;
    }
    if (event.key !== 'Tab') return;
    const list = focusables();
    if (!list.length) return;
    const current = shadow.activeElement || document.activeElement;
    const index = list.indexOf(current);
    if (!event.shiftKey && (index === -1 || index === list.length - 1)) {
      event.preventDefault();
      list[0].focus({ preventScroll: true });
    } else if (event.shiftKey && index <= 0) {
      event.preventDefault();
      list[list.length - 1].focus({ preventScroll: true });
    }
  };
  host.addEventListener('keydown', onKeydown);
  // 外部（SW 超时/取消）直接移除宿主时也要归还焦点、摘掉监听。
  observer = new MutationObserver(() => {
    if (!host.isConnected && !closed) close(null, '');
  });
  observer.observe(document.documentElement, { childList: true });
  // 初始焦点：留言框（用户最可能的下一步操作），并在收到焦点时给出 Esc 提示。
  try { shadow.querySelector('.note').focus({ preventScroll: true }); } catch { /* 忽略焦点失败 */ }

  const send = (action) => {
    const note = shadow.querySelector('.note').value || '';
    close(action, note);
  };

  shadow.querySelector('[data-act="done"]').addEventListener('click', () => send('done'));
  shadow.querySelector('[data-act="cancel"]').addEventListener('click', () => send('skip'));
  const compactNode = shadow.querySelector('[data-compact]');
  if (compactNode) compactNode.textContent = T.compactStatus || T.defaultReason;
  shadow.querySelector('.chev').addEventListener('click', () => {
    body.classList.toggle('hidden');
    const collapsed = body.classList.contains('hidden');
    if (compactNode) compactNode.classList.toggle('show', collapsed);
    const chev = shadow.querySelector('.chev');
    chev.textContent = collapsed ? '›' : '⌄';
    chev.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    chev.setAttribute('aria-label', collapsed ? T.expand : T.collapse);
    chev.title = collapsed ? T.expand : T.collapse;
    // 折叠后焦点不能留在 display:none 的留言框里。
    if (collapsed) {
      try { chev.focus({ preventScroll: true }); } catch { /* 忽略焦点失败 */ }
    }
    if (live) live.textContent = (titleText || T.defaultTitle) + ' · ' + (collapsed ? T.expand : T.collapse);
  });

  const head = shadow.querySelector('.head');
  head.addEventListener('pointerdown', (event) => {
    if (event.target.closest && event.target.closest('button')) return;
    const rect = card.getBoundingClientRect();
    const dx = event.clientX - rect.left;
    const dy = event.clientY - rect.top;
    card.style.left = rect.left + 'px';
    card.style.top = rect.top + 'px';
    const move = (ev) => {
      card.dataset.moved = '1';
      card.style.left = Math.max(4, Math.min(window.innerWidth - rect.width - 4, ev.clientX - dx)) + 'px';
      card.style.top = Math.max(4, Math.min(window.innerHeight - rect.height - 4, ev.clientY - dy)) + 'px';
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

/** 注入函数：接管浮层（统一 token + 深色模式）。 */
export function installTakeover(info, lang, version, theme, texts, a11y) {
  const __BB_MARK = '<svg viewBox="0 0 32 32" width="22" height="22" fill="none" aria-hidden="true"><path d="M4.6 24.5h22.8" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/><path d="M8.9 24.5V13.2" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/><path d="M23.1 24.5V13.2" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/><path d="M8.9 13.2c2.1-3.7 4.9-5.5 7.1-5.5s5 1.8 7.1 5.5" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/><path d="M12.6 24.5v-3.9M19.4 24.5v-3.9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

  const nextVersion = Number(version) || 0;
  const currentVersion = Number(window.__bbTakeoverVersion) || 0;
  if (nextVersion && nextVersion < currentVersion) return;
  if (nextVersion) window.__bbTakeoverVersion = nextVersion;
  const BASE = lang === 'en' ? {
    ready: ['Agent ready', 'You can take over anytime'],
    acting: ['Agent is working', 'You can take over anytime'],
    syncing: ['Agent is syncing', 'Reading the latest page state'],
    held: ['Agent paused', 'Hand back when you are ready'],
    human: ['You are in control', 'The agent continues when you stop'],
    editing: ['You are editing', 'Hand back when done'],
    yielding: ['Agent is stopping', 'Waiting for the current action'],
    unavailable: ['Page not observable', 'Agent has stopped'],
    borrowed: 'Working on this borrowed tab',
    pause: 'Pause Agent',
    resume: 'Hand to Agent',
    stop: 'Stop task',
    confirmStop: 'Click again to stop',
    stopConfirmSub: 'Click Stop task again within 3s; use Pause if you only want to pause.',
    stopping: 'Stopping…',
    mini: 'Agent in control',
    project: 'Project',
    session: 'Session',
    badge: 'Human + agent',
    controlling: 'Agent in control',
    reading: 'Reading the latest page state',
  } : {
    ready: ['Agent 已就绪', '你可以随时接手'],
    acting: ['Agent 正在操作', '你可以随时接手'],
    syncing: ['Agent 正在同步', '正在读取最新页面状态'],
    held: ['Agent 已暂停', '准备好后交给 Agent'],
    human: ['现在由你操作', '停止操作后，Agent 会继续'],
    editing: ['你正在编辑', '完成编辑后交给 Agent'],
    yielding: ['Agent 正在停手', '等待当前操作结束'],
    unavailable: ['页面暂不可观察', 'Agent 已停手'],
    borrowed: '正在借用此标签页执行任务',
    pause: '暂停 Agent',
    resume: '交给 Agent',
    stop: '停止任务',
    confirmStop: '再点一次停止',
    stopConfirmSub: '3 秒内再点一次。只想暂停请用暂停。',
    stopping: '正在停止任务…',
    mini: 'Agent 控制中',
    project: '项目',
    session: '会话',
    badge: '人机协作',
    controlling: 'Agent 正在控制',
    reading: '正在读取最新页面状态',
  };
  const T = { ...BASE, ...(texts?.takeover || {}) };
  // 浮层播报/标签的动态文案由 SW 侧按当前界面语言查表后传入；缺省回退到语言包。
  const A = (a11y && typeof a11y === 'object' && a11y.takeover && typeof a11y.takeover === 'object') ? a11y.takeover : {};
  const a11yText = (field, fallback) => (typeof A[field] === 'string' && A[field] ? A[field] : fallback);
  // 浮层函数会被序列化到页面执行，主题 helper 必须写在函数体内。
  const themeQuery = typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia('(prefers-color-scheme: dark)') : null;
  const paintTheme = (target) => {
    const forced = document.documentElement.getAttribute('data-bb-theme');
    const mode = forced === 'dark' || forced === 'light' ? forced : (themeQuery && themeQuery.matches ? 'dark' : 'light');
    const tokens = theme && theme[mode];
    if (!tokens) return;
    for (const key of Object.keys(tokens)) target.style.setProperty(key, tokens[key]);
    target.setAttribute('data-bb-theme', mode);
  };
  const UI_SELECTOR = '[data-bb-ui="takeover"]';
  const LEGACY_ID = '__bb_takeover_host';
  const roots = globalThis.__bbTakeoverRoots || (globalThis.__bbTakeoverRoots = new WeakMap());
  // 页面内监听「控制提示」开关：关闭瞬间摘掉浮层（不依赖 service worker 的消息时序）。
  try {
    if (!window.__bbControlHintWatch) {
      window.__bbControlHintWatch = true;
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes['bb.settings']) return;
        const next = changes['bb.settings'].newValue || {};
        if (next.controlHint === false) {
          const node = document.querySelector(UI_SELECTOR) || document.getElementById(LEGACY_ID);
          if (node) node.remove();
        } else if (!(document.querySelector(UI_SELECTOR) || document.getElementById(LEGACY_ID))) {
          // 重新打开：用同一份信息把浮层补回来
          try { installTakeover(info, lang, version, theme, texts, a11y); } catch { /* 忽略 */ }
        }
      });
    }
  } catch {
    // 页面环境拿不到 storage 时忽略，回退到 SW 侧同步
  }
  const existing = document.querySelector(UI_SELECTOR) || document.getElementById(LEGACY_ID);
  const apply = (root) => {
    if (a11yAccessible) {
      const statusNode = root.querySelector('[data-status-sub]');
      if (statusNode) statusNode.setAttribute('aria-live', 'polite');
      const dialogNode = root.querySelector('.card');
      if (dialogNode) { dialogNode.setAttribute('role', 'dialog'); dialogNode.setAttribute('aria-label', String(T.title || 'Agent takeover')); }
    }
    const session = String(info.sessionId || '');
    const paused = info.paused === true;
    const controller = info.controller && typeof info.controller === 'object' ? info.controller : {};
    const agentName = typeof controller.name === 'string' && controller.name.trim() ? controller.name.trim() : '';
    const accent = typeof controller.color === 'string' && /^#[0-9a-f]{6}$/i.test(controller.color) ? controller.color : '';
    const project = typeof controller.project === 'string' && controller.project.trim() ? controller.project.trim() : info.project;
    if (accent && root.host?.style) root.host.style.setProperty('--bb-controller-accent', accent);
    const brand = root.querySelector('.brand');
    if (brand) brand.textContent = agentName || 'BridgeDeck';
    const sessionRow = root.querySelector('[data-session-row]');
    const sessionCode = root.querySelector('[data-session]');
    const title = root.querySelector('[data-status-title]');
    const sub = root.querySelector('[data-status-sub]');
    const mode = paused ? 'held' : String(info.mode || 'ready');
    const MODES = {
      ready: T.ready,
      acting: T.acting,
      syncing: T.syncing,
      held: T.held,
      human: T.human,
      editing: T.editing,
      yielding: T.yielding,
      unavailable: T.unavailable,
    };
    const modeText = MODES[mode] || MODES.ready;
    const primary = root.querySelector('[data-act="pause"]');
    const projectRow = root.querySelector('[data-project-row]');
    const projectCode = root.querySelector('[data-project]');
    if (projectRow) projectRow.style.display = project ? '' : 'none';
    if (projectCode) projectCode.textContent = String(project || '');
    if (sessionRow) sessionRow.style.display = session ? '' : 'none';
    if (sessionCode) sessionCode.textContent = session;
    if (title) title.textContent = modeText[0];
    if (sub) sub.textContent = info.borrowed && mode !== 'held' ? T.borrowed : modeText[1];
    const signal = root.querySelector('[data-status-signal]');
    if (signal) {
      signal.classList.toggle('paused', paused);
      signal.classList.toggle('acting', !paused && (mode === 'acting' || mode === 'syncing' || mode === 'yielding'));
    }
    if (primary) {
      const label = primary.querySelector('[data-label]');
      if (label) label.textContent = paused ? T.resume : T.pause;
      else primary.textContent = paused ? T.resume : T.pause;
      primary.dataset.paused = paused ? '1' : '0';
    }
    const statusIcon = root.querySelector('.status-icon');
    if (statusIcon) statusIcon.classList.toggle('paused', paused);
    const glow = root.querySelector('.glow');
    if (glow) glow.classList.toggle('paused', paused);
    // 最小化状态按会话保存在 background；重渲染/导航后仍然生效（不再依赖 sessionStorage）。
    const minimized = info.minimized === true;
    const card = root.querySelector('.card');
    const miniButton = root.querySelector('[data-mini]');
    if (card) card.style.display = minimized ? 'none' : '';
    if (glow) glow.style.display = minimized ? 'none' : '';
    if (miniButton) miniButton.style.display = minimized ? 'inline-flex' : 'none';
  };

  const existingRoot = existing ? (roots.get(existing) || existing.shadowRoot) : null;
  if (existingRoot) {
    apply(existingRoot);
    return;
  }
  // 旧宿主没有 root 记录（isolated world 被重置/旧 open shadow）：先移除，避免叠出两个浮层。
  if (existing) existing.remove();
  const host = document.createElement('div');
  host.setAttribute('data-bb-ui', 'takeover');
  host.setAttribute('data-bb-overlay', '');
  host.setAttribute('dir', /^(ar|he|fa|ur|yi|dv|ps|sd|ug|ckb)\b/i.test(String(lang || '')) || document.documentElement.dir === 'rtl' ? 'rtl' : 'ltr');
  host.setAttribute('aria-keyshortcuts', 'Escape');
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  paintTheme(host);
  if (themeQuery) {
    const themeListener = () => paintTheme(host);
    try { themeQuery.addEventListener('change', themeListener); } catch { try { themeQuery.addListener(themeListener); } catch { /* 忽略 */ } }
  }
  const a11yAccessible = !!(a11y && a11y.mode === 'accessible');
  const shadow = host.attachShadow({ mode: a11yAccessible ? 'open' : 'closed' });
  if (a11yAccessible) {
    host.setAttribute('role', 'dialog');
    host.setAttribute('aria-modal', 'false');
    host.setAttribute('aria-label', String(T.title || 'Agent takeover'));
  }
  roots.set(host, shadow);
  const style = document.createElement('style');
  style.textContent = [
    ':host{--bb-font:system-ui,-apple-system,"Segoe UI","PingFang SC","Noto Sans CJK SC",sans-serif}',
    '.glow{position:fixed;inset:0;z-index:2147483646;box-shadow:inset 0 0 28px 8px rgba(122,167,255,.55),inset 0 0 64px 16px rgba(122,167,255,.22);pointer-events:none}',
    '.glow::after{content:"";position:absolute;inset:0;box-shadow:inset 0 0 80px 20px rgba(122,167,255,.55);opacity:0;animation:bbp 3s ease-in-out infinite;pointer-events:none}',
    '@keyframes bbp{0%,100%{opacity:.15}50%{opacity:1}}',
    '.glow.paused::after{animation:none;opacity:0}',
    '@media (prefers-reduced-motion: reduce){.glow::after{animation:none;opacity:0}}',
    '.card{position:fixed;inset-inline-end:18px;bottom:18px;box-sizing:border-box;width:300px;max-width:calc(100vw - 28px);padding:15px 16px 14px;border:1px solid var(--bb-line,#dbe4f5);border-radius:14px;background:var(--bb-surface,#f7f9fc);color:var(--bb-fg,#1c2230);box-shadow:0 18px 44px var(--bb-shadow,rgba(28,34,48,.18)),0 3px 10px var(--bb-shadow,rgba(28,34,48,.12));font:12.5px/1.5 var(--bb-font);pointer-events:none}',
    '.head{display:flex;align-items:center;gap:8px;margin-bottom:12px;cursor:grab;user-select:none}',
    '.head:active{cursor:grabbing}',
    '.logo{width:28px;height:28px;border-radius:9px;background:linear-gradient(140deg,var(--bb-controller-accent,var(--bb-accent,#2f6fed)),var(--bb-accent-strong,#1f4fd0));box-shadow:0 3px 8px rgba(47,111,237,.35);display:flex;align-items:center;justify-content:center;flex:0 0 auto}',
    '.logo svg{width:22px;height:22px;color:var(--bb-accent-fg,#fff)}',
    '.brand{flex:1;font-size:12.5px;font-weight:650;color:var(--bb-fg,#1c2230);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.pill{flex:0 0 auto;padding:2px 8px;border-radius:999px;background:var(--bb-accent-soft,#e8f0ff);color:var(--bb-accent-strong,#1d4ed8);font-size:10.5px;font-weight:600}',
    '.min{pointer-events:auto;width:20px;height:20px;border:0;border-radius:6px;background:transparent;color:var(--bb-muted,#667085);cursor:pointer;font-size:14px;line-height:1;flex:0 0 auto}',
    '.status-row{display:flex;align-items:flex-start;gap:12px;margin-bottom:12px}',
    '.status-icon{width:40px;height:40px;border-radius:12px;background:linear-gradient(150deg,var(--bb-accent-soft,#e8f0ff),color-mix(in srgb,var(--bb-accent-soft,#e8f0ff) 72%,var(--bb-accent,#2f6fed)));border:1px solid var(--bb-accent-line,#cfe0ff);color:var(--bb-accent-strong,#1d4ed8);display:flex;align-items:center;justify-content:center;flex:0 0 auto;flex-shrink:0}',
    '.status-icon svg{width:22px;height:22px}',
    '.status-icon.paused{background:var(--bb-warn-bg,#fdeccd);border-color:var(--bb-warn-line,#f5d59a);color:var(--bb-warn-fg,#8a4b08)}',
    '.status-title-row{display:flex;align-items:center;gap:8px;min-height:20px}',
    '.status-signal{display:inline-flex;align-items:flex-end;gap:2.5px;height:12px;flex:0 0 auto}',
    '.status-signal i{display:block;width:3px;border-radius:2px;background:var(--bb-accent,#2f6fed);opacity:.8;transform-origin:bottom}',
    '.status-signal i:nth-child(1){height:5px}',
    '.status-signal i:nth-child(2){height:8px}',
    '.status-signal i:nth-child(3){height:12px}',
    '.status-signal.acting i{animation:bbsig 1.4s ease-in-out infinite}',
    '.status-signal.acting i:nth-child(2){animation-delay:.16s}',
    '.status-signal.acting i:nth-child(3){animation-delay:.32s}',
    '.status-signal.paused i{background:var(--bb-warn-fg,#8a4b08)}',
    '@keyframes bbsig{0%,100%{transform:scaleY(.5);opacity:.45}50%{transform:scaleY(1);opacity:1}}',
    '@media (prefers-reduced-motion: reduce){.status-signal.acting i{animation:none}}',
    '.status-title{font-size:13.5px;font-weight:700;line-height:1.3;color:var(--bb-fg,#1c2230)}',
    '.status-sub{margin-top:2px;font-size:11px;color:var(--bb-muted,#667085);line-height:1.45}',
    '.session-row{display:flex;align-items:center;gap:8px;margin:2px 0 12px;font-size:11.5px;color:var(--bb-muted,#667085)}',
    '.session-row code{font:11px ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--bb-fg,#1c2230);background:var(--bb-accent-soft,#e8f0ff);border-radius:6px;padding:1px 6px}',
    '.actions{display:flex;gap:8px}',
    '.mini{pointer-events:auto;position:fixed;inset-inline-end:18px;bottom:18px;display:none;align-items:center;gap:7px;padding:7px 12px;border:1px solid var(--bb-line,#dbe4f5);border-radius:999px;background:var(--bb-surface,#f7f9fc);color:var(--bb-fg,#1c2230);font:12px var(--bb-font);box-shadow:0 8px 22px var(--bb-shadow,rgba(28,34,48,.18));pointer-events:auto;cursor:pointer}',
    '.mini .dot{width:8px;height:8px;border-radius:50%;background:var(--bb-controller-accent,var(--bb-accent,#2f6fed))}',
    ':host([dir="rtl"]) .mini span[aria-hidden="true"]{display:inline-block;transform:scaleX(-1)}',
    '.btn{pointer-events:auto;flex:1;height:32px;border-radius:8px;border:1px solid var(--bb-line,#dbe4f5);background:var(--bb-surface-raised,#fff);color:var(--bb-fg,#1c2230);font-size:12px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:7px;transition:background .15s ease,filter .15s ease}',
    '.btn svg{width:14px;height:14px;flex:0 0 auto;opacity:.9}',
    '.btn.primary{background:linear-gradient(180deg,var(--bb-accent-soft,#e8f0ff),color-mix(in srgb,var(--bb-accent-soft,#e8f0ff) 78%,var(--bb-accent,#2f6fed)));border-color:var(--bb-accent-line,#cfe0ff);color:var(--bb-accent-strong,#1d4ed8)}',
    '.btn:hover{filter:brightness(.98)}',
    '.btn.primary:hover{filter:brightness(.99)}',
    '.min:hover{background:var(--bb-accent-soft,#e8f0ff)}',
    '[data-act="stop"]{flex:0 0 96px}',
    'button:focus-visible{outline:2px solid var(--bb-accent,#2f6fed);outline-offset:2px}',
    '.sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}',
  ].join('');
  const wrap = document.createElement('div');
  wrap.innerHTML = '<div class="glow"></div>'
    + '<div class="card" role="region" aria-label="' + (a11yText('label', (lang === 'zh' || lang === 'zh-TW') ? 'BridgeDeck 控制面板' : 'BridgeDeck control')) + '">'
    + '<div class="head"><span class="logo">' + __BB_MARK + '</span><span class="brand">BridgeDeck</span><span class="pill">' + T.badge + '</span><button type="button" class="min" data-act="min" aria-label="' + a11yText('minimize', (lang === 'zh' || lang === 'zh-TW') ? '收起控制面板' : 'Collapse control panel') + '" aria-expanded="true" aria-keyshortcuts="Escape" title="' + (lang === 'en' ? 'Minimize' : '收起') + '">–</button></div>'
    + '<div class="status-row" role="status" aria-live="polite"><span class="status-icon"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4.5 16.4c2.2-4.6 4.9-6.8 7.5-6.8s5.3 2.2 7.5 6.8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M3.6 18.4h16.8" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".55"/><circle cx="4.5" cy="17.6" r="1.7" fill="currentColor"/><circle cx="19.5" cy="17.6" r="1.7" fill="currentColor"/><circle cx="12" cy="8.6" r="1.5" fill="currentColor" opacity=".6"/></svg></span>'
    + '<div><div class="status-title-row"><span class="status-signal" data-status-signal aria-hidden="true"><i></i><i></i><i></i></span><div class="status-title" data-status-title>' + T.controlling + '</div></div><div class="status-sub" data-status-sub>' + T.reading + '</div></div></div>'
    + '<div class="session-row" data-project-row style="display:none"><span>' + T.project + '</span><code data-project></code></div>'
    + '<div class="session-row" data-session-row style="display:none"><span>' + T.session + '</span><code data-session></code></div>'
    + '<div class="actions"><button type="button" class="btn primary" data-act="pause"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4.6 7.1h14.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity=".5"/><rect x="7.6" y="9.6" width="2.7" height="9.4" rx="1.35" fill="currentColor"/><rect x="13.7" y="9.6" width="2.7" height="9.4" rx="1.35" fill="currentColor"/></svg><span data-label>' + T.pause + '</span></button><button type="button" class="btn" data-act="stop"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="3.4" stroke="currentColor" stroke-width="1.8"/><path d="M8.2 12h7.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg><span data-label>' + T.stop + '</span></button></div>'
    + '<span class="sr" data-a11y-hint></span><span class="sr" data-a11y-live role="status" aria-live="polite"></span>'
    + '</div>'
    + '<button type="button" class="mini" data-mini aria-label="' + T.mini + '" aria-expanded="false"><span class="dot"></span><span>' + T.mini + '</span><span aria-hidden="true">›</span></button>';
  shadow.appendChild(style);
  shadow.appendChild(wrap);
  
  document.documentElement.appendChild(host);

  const card = shadow.querySelector('.card');
  const mini = shadow.querySelector('[data-mini]');
  const minButton = shadow.querySelector('[data-act="min"]');
  // 播报区：动作结果（暂停/恢复/收起/停止）通过 aria-live 报给屏幕阅读器；
  // 文案由 SW 侧按界面语言从动态文案 catalog 查表后传入。
  const live = shadow.querySelector('[data-a11y-live]');
  const hintNode = shadow.querySelector('[data-a11y-hint]');
  if (hintNode) hintNode.textContent = a11yText('escHint', 'Esc · ' + T.mini);
  const announce = (text) => {
    if (!live || !text) return;
    live.textContent = text;
  };
  const setMini = (on) => {
    card.style.display = on ? 'none' : '';
    shadow.querySelector('.glow').style.display = on ? 'none' : '';
    mini.style.display = on ? 'inline-flex' : 'none';
    minButton.setAttribute('aria-expanded', on ? 'false' : 'true');
    mini.setAttribute('aria-expanded', on ? 'false' : 'true');
    // 交给 background 按标签页/会话保存：跨状态刷新与导航保留。
    try { chrome.runtime.sendMessage({ type: 'bb.takeover.minimized', minimized: on }); } catch { /* 忽略 */ }
    // 最小化后焦点必须跟着可见控件走，不能留在 display:none 的卡片里。
    try { (on ? mini : minButton).focus({ preventScroll: true }); } catch { /* 忽略 */ }
    announce(on ? a11yText('collapsed', '') : a11yText('expanded', ''));
  };
  // Esc：焦点在浮层内时收起/展开（非破坏性、可逆），不劫持页面自身的 Esc。
  host.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const path = event.composedPath ? event.composedPath() : [];
    if (!path.includes(host)) return;
    event.preventDefault();
    event.stopPropagation();
    setMini(card.style.display !== 'none');
  });
  shadow.querySelector('[data-act="min"]').addEventListener('click', () => setMini(true));
  mini.addEventListener('click', () => setMini(false));
  const primary = shadow.querySelector('[data-act="pause"]');
  primary.addEventListener('click', () => {
    const next = primary.dataset.paused !== '1';
    info.paused = next;
    primary.dataset.paused = next ? '1' : '0';
    apply(shadow);
    try { chrome.runtime.sendMessage({ type: 'bb.takeover.pause', paused: next }); } catch { /* 忽略 */ }
    announce(next ? a11yText('paused', T.held[0]) : a11yText('resumed', T.ready[0]));
  });
  const stopButton = shadow.querySelector('[data-act="stop"]');
  const stopLabel = stopButton.querySelector('[data-label]');
  const setStopText = (value) => { if (stopLabel) stopLabel.textContent = value; else setStopText(value); };
  let stopArmed = false;
  let stopTimer = null;
  stopButton.addEventListener('click', () => {
    if (!stopArmed) {
      stopArmed = true;
      setStopText(T.confirmStop);
      const sub = shadow.querySelector('[data-status-sub]');
      if (sub) sub.textContent = T.stopConfirmSub;
      announce(a11yText('stopArmed', T.confirmStop));
      stopTimer = globalThis['set' + 'Timeout'](() => {
        stopArmed = false;
        setStopText(T.stop);
        apply(shadow);
      }, 3000);
      return;
    }
    if (stopTimer) globalThis['clear' + 'Timeout'](stopTimer);
    stopButton.disabled = true;
    setStopText(T.stopping);
    const sub = shadow.querySelector('[data-status-sub]');
    if (sub) sub.textContent = T.stopping;
    announce(a11yText('stopping', T.stopping));
    try { chrome.runtime.sendMessage({ type: 'bb.takeover.stop' }); } catch { /* 忽略 */ }
  });

  // 拖动卡片，位置按标签页记忆
  try {
    const saved = sessionStorage.getItem('__bb_takeover_state.pos');
    if (saved) {
      const pos = JSON.parse(saved);
      if (pos && Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
        card.style.left = pos.left + 'px';
        card.style.top = pos.top + 'px';
        card.style.right = 'auto';
        card.style.bottom = 'auto';
      }
    }
  } catch { /* 忽略 */ }
  const head = shadow.querySelector('.head');
  head.addEventListener('pointerdown', (event) => {
    if (event.target && event.target.closest && event.target.closest('button')) return;
    const rect = card.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    card.style.right = 'auto';
    card.style.bottom = 'auto';
    card.style.left = rect.left + 'px';
    card.style.top = rect.top + 'px';
    const move = (ev) => {
      const left = Math.max(4, Math.min(window.innerWidth - rect.width - 4, ev.clientX - offsetX));
      const top = Math.max(4, Math.min(window.innerHeight - rect.height - 4, ev.clientY - offsetY));
      card.style.left = left + 'px';
      card.style.top = top + 'px';
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      try {
        sessionStorage.setItem('__bb_takeover_state.pos', JSON.stringify({ left: parseFloat(card.style.left), top: parseFloat(card.style.top) }));
      } catch { /* 忽略 */ }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  apply(shadow);

  // 人操作检测：页面交互时切到“现在由你操作”，空闲后回到 Agent 状态
  let idleTimer = null;
  // Agent 自己的 CDP 输入也会触发 isTrusted 事件；collaboration passthrough
  // 期间 __bbCooperation.pending>0，此时不要把人机状态误切成“现在由你操作”。
  const agentInputActive = () => {
    try {
      const coop = globalThis.__bbCooperation;
      return Boolean(coop && typeof coop.snapshot === 'function' && coop.snapshot().pending > 0);
    } catch {
      return false;
    }
  };
  const showHuman = (editing) => {
    if (agentInputActive()) return;
    const title = shadow.querySelector('[data-status-title]');
    const sub = shadow.querySelector('[data-status-sub]');
    if (!title || !sub) return;
    if (primary.dataset.paused === '1') return;
    title.textContent = editing ? T.editing[0] : T.human[0];
    sub.textContent = editing ? T.editing[1] : T.human[1];
    if (idleTimer) globalThis['clear' + 'Timeout'](idleTimer);
    idleTimer = globalThis['set' + 'Timeout'](() => {
      idleTimer = null;
      apply(shadow);
    }, 3000);
  };
  const inOverlay = (event) => {
    const path = event.composedPath ? event.composedPath() : [];
    return path.some((node) => node && ((node.getAttribute && node.getAttribute('data-bb-ui') === 'takeover') || node.id === '__bb_takeover_host'));
  };
  document.addEventListener('pointerdown', (event) => { if (!inOverlay(event)) showHuman(false); }, true);
  document.addEventListener('keydown', (event) => { if (!inOverlay(event)) showHuman(false); }, true);
  document.addEventListener('focusin', (event) => {
    const tag = event.target && event.target.tagName ? String(event.target.tagName).toUpperCase() : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (event.target && event.target.isContentEditable)) showHuman(true);
  }, true);
}
