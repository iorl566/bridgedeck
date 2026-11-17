// src/overlay-ui.js —— 真正注入页面的内联浮层（借用模态/Toast、Help、Takeover）。
//
// 这里的函数会被 chrome.scripting.executeScript 序列化后在页面里执行，所以：
// 1. 不能 import 任何模块，也不能引用模块作用域变量；
// 2. 主题 token 由调用方（tabs.js / takeover.js）作为参数传入；
// 3. 所有颜色/边框/阴影走 overlay-theme.js 的 --bb-* 变量，并带浅色兜底值。
// 本文件也是 tests/browser/overlay-dom.js 直接调用的真实 DOM 组件实现。

/** 注入函数：借用确认模态。必须自包含（序列化后在页面里执行）。 */
export function borrowBanner(requestId, tabTitle, timeoutMs, lang, theme, texts) {
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
  host.setAttribute('role', 'dialog');
  host.setAttribute('aria-modal', 'true');
  host.setAttribute('aria-label', T.title);
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:var(--bb-backdrop,rgba(15,23,42,.42));backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;pointer-events:auto';
  const card = document.createElement('div');
  card.style.cssText = 'box-sizing:border-box;width:400px;max-width:calc(100vw - 32px);background:var(--bb-surface,#f7f9fc);color:var(--bb-fg,#1c2230);border:1px solid var(--bb-line,#dbe4f5);border-radius:16px;padding:22px 24px 20px;box-shadow:0 25px 50px var(--bb-shadow-strong,rgba(28,34,48,.28));font:13px/1.5 system-ui,sans-serif';
  const title = String(tabTitle || '').slice(0, 30) + (String(tabTitle || '').length > 30 ? '…' : '');
  card.innerHTML = '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">'
    + '<span style="width:22px;height:22px;border-radius:6px;background:var(--bb-accent,#2f6fed);display:inline-flex;align-items:center;justify-content:center"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="var(--bb-accent-fg,#fff)" stroke-width="2.2" stroke-linecap="round"><path d="M3 17h18"/><path d="M6 17V9"/><path d="M18 17V9"/><path d="M6 9c3 4 9 4 12 0"/></svg></span>'
    + '<strong style="font-size:15px;color:var(--bb-fg,#1c2230)">' + T.title + '</strong></div>'
    + '<p style="margin:0 0 8px;color:var(--bb-body,#475569)">' + T.body + '</p>'
    + '<p style="margin:0 0 14px;color:var(--bb-muted,#667085);font-size:12px">' + T.target + (title ? title.replace(/[<>&]/g, '') : ((lang === 'zh' || lang === 'zh-TW') ? '当前标签页' : 'Current tab')) + '</p>'
    + '<div style="display:flex;align-items:center;justify-content:center;gap:12px;margin:6px 0 16px">'
    + '<svg width="44" height="44" viewBox="0 0 44 44"><circle cx="22" cy="22" r="18" fill="none" stroke="var(--bb-line,#dbe4f5)" stroke-width="4"/><circle data-ring cx="22" cy="22" r="18" fill="none" stroke="var(--bb-accent,#2f6fed)" stroke-width="4" stroke-linecap="round" stroke-dasharray="113.1" stroke-dashoffset="0" transform="rotate(-90 22 22)"/></svg>'
    + '<span data-count style="font-size:12.5px;color:var(--bb-muted,#667085)"></span></div>'
    + '<div style="display:flex;gap:10px"><button type="button" data-deny style="flex:1;height:34px;border-radius:9px;border:1px solid var(--bb-line,#dbe4f5);background:var(--bb-surface-raised,#fff);color:var(--bb-fg,#1c2230);font-size:12.5px;font-weight:550;cursor:pointer">' + T.deny + '</button>'
    + '<button type="button" data-allow style="flex:1;height:34px;border-radius:9px;border:1px solid var(--bb-accent,#2f6fed);background:var(--bb-accent,#2f6fed);color:var(--bb-accent-fg,#fff);font-size:12.5px;font-weight:600;cursor:pointer">' + T.allow + '</button></div>';
  host.appendChild(card);
  paintTheme(host);
  if (themeQuery) {
    const themeListener = () => paintTheme(host);
    try { themeQuery.addEventListener('change', themeListener); } catch { try { themeQuery.addListener(themeListener); } catch { /* 忽略 */ } }
  }
  document.documentElement.appendChild(host);

  const ring = card.querySelector('[data-ring]');
  const count = card.querySelector('[data-count]');
  const denyBtn = card.querySelector('[data-deny]');
  const allowBtn = card.querySelector('[data-allow]');
  const previousFocus = document.activeElement;
  const circumference = 2 * Math.PI * 18;
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
    count.textContent = lang === 'en' ? T.autoDeny + left + ' s' : left + T.autoDeny;
    ring.style.strokeDashoffset = String(circumference * (1 - left / total));
  };
  paint();
  const timer = globalThis['set' + 'Interval'](() => {
    left -= 1;
    if (left <= 0) {
      globalThis['clear' + 'Interval'](timer);
      finish(false, true);
      return;
    }
    paint();
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
export function borrowToast(requestId, tabTitle, timeoutMs, lang, theme, texts) {
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
  let host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('data-bb-ui', 'borrow-toast');
    host.setAttribute('data-bb-overlay', '');
    host.setAttribute('role', 'region');
    host.setAttribute('aria-label', T.title);
    host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;display:flex;flex-direction:column;gap:8px;pointer-events:none;font:12.5px/1.5 system-ui,sans-serif';
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
    + '<span style="width:18px;height:18px;border-radius:5px;background:var(--bb-accent,#2f6fed);display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="var(--bb-accent-fg,#fff)" stroke-width="2.2" stroke-linecap="round"><path d="M3 17h18"/><path d="M6 17V9"/><path d="M18 17V9"/><path d="M6 9c3 4 9 4 12 0"/></svg></span>'
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
}

/** 注入函数：人工协助卡片（统一 token + 深色模式）。 */
export function helpOverlayFunc(requestId, reason, targetSelector, targetRect, titleText, lang, theme, texts) {
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

  let target = null;
  if (targetSelector) {
    try { target = document.querySelector(targetSelector); } catch { target = null; }
  }

  const hl = document.createElement('div');
  hl.id = HL;
  hl.setAttribute('data-bb-overlay', '');
  hl.style.cssText = 'position:fixed;z-index:2147483645;pointer-events:none;border:2px solid var(--bb-accent,#2f6fed);border-radius:8px;box-shadow:0 0 0 6px var(--bb-accent-soft,#e8f0ff),0 0 22px var(--bb-shadow-strong,rgba(28,34,48,.28));display:none';
  document.documentElement.appendChild(hl);

  const host = document.createElement('div');
  host.id = HOST;
  host.setAttribute('data-bb-ui', 'help');
  host.setAttribute('data-bb-overlay', '');
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
    '.card{position:fixed;box-sizing:border-box;width:380px;max-width:calc(100vw - 24px);background:var(--bb-surface,#f7f9fc);color:var(--bb-fg,#1c2230);border:1px solid var(--bb-line,#dbe4f5);border-radius:14px;box-shadow:0 16px 40px var(--bb-shadow,rgba(28,34,48,.18)),0 3px 8px var(--bb-shadow,rgba(28,34,48,.18));font:12.5px/1.5 var(--bb-font);pointer-events:auto}',
    '.dragbar{position:absolute;top:6px;left:50%;transform:translateX(-50%);width:36px;height:4px;border-radius:2px;background:var(--bb-line,#dbe4f5)}',
    '.head{display:flex;align-items:center;gap:9px;padding:16px 14px 8px;cursor:grab;user-select:none}',
    '.logo{width:20px;height:20px;border-radius:6px;background:var(--bb-accent,#2f6fed);display:flex;align-items:center;justify-content:center;flex:0 0 auto}',
    '.logo svg{width:13px;height:13px;color:var(--bb-accent-fg,#fff)}',
    '.title{flex:1;font-size:13px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--bb-fg,#1c2230)}',
    '.chev{width:22px;height:22px;border:0;background:transparent;color:var(--bb-muted,#667085);cursor:pointer;border-radius:6px;font-size:14px;line-height:1}',
    '.chev:hover{background:var(--bb-accent-soft,#e8f0ff)}',
    '.body{padding:0 14px 14px}',
    '.body.hidden{display:none}',
    '.msg{margin:2px 0 10px;font-size:12.5px;line-height:1.55;color:var(--bb-fg,#1c2230)}',
    '.note{width:100%;box-sizing:border-box;min-height:38px;max-height:90px;resize:vertical;border:1px solid var(--bb-line,#dbe4f5);border-radius:9px;background:var(--bb-surface-raised,#fff);color:var(--bb-fg,#1c2230);font:12px/1.5 var(--bb-font);padding:8px 10px}',
    '.note::placeholder{color:var(--bb-muted,#667085)}',
    '.actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}',
    '.btn{height:32px;padding:0 14px;border-radius:9px;border:1px solid var(--bb-line,#dbe4f5);background:var(--bb-surface-raised,#fff);color:var(--bb-fg,#1c2230);font-size:12px;font-weight:550;cursor:pointer}',
    '.btn.primary{background:var(--bb-accent,#2f6fed);border-color:var(--bb-accent,#2f6fed);color:var(--bb-accent-fg,#fff)}',
    'button:focus-visible{outline:2px solid var(--bb-accent,#2f6fed);outline-offset:2px}',
  ].join('');
  const wrap = document.createElement('div');
  wrap.innerHTML = '<div class="card" role="dialog" aria-label="' + T.defaultTitle + '"><div class="dragbar"></div>'
    + '<div class="head"><span class="logo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M3 17h18"/><path d="M6 17V9"/><path d="M18 17V9"/><path d="M6 9c3 4 9 4 12 0"/></svg></span><span class="title"></span><button type="button" class="chev" aria-label="' + T.collapse + '" aria-expanded="true" title="' + T.collapse + '">⌄</button></div>'
    + '<div class="body"><p class="msg"></p><textarea class="note" aria-label="' + T.placeholder + '" placeholder="' + T.placeholder + '"></textarea>'
    + '<div class="actions"><button type="button" class="btn" data-act="cancel">' + T.cancel + '</button><button type="button" class="btn primary" data-act="done">' + T.done + '</button></div></div>'
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

  const place = () => {
    if (targetRect && targetRect.width >= 0) {
      hl.style.display = 'block';
      hl.style.left = (targetRect.x - 3) + 'px';
      hl.style.top = (targetRect.y - 3) + 'px';
      hl.style.width = (targetRect.width + 6) + 'px';
      hl.style.height = (targetRect.height + 6) + 'px';
      if (!card.dataset.moved) {
        const left = Math.max(12, Math.min(window.innerWidth - 392, targetRect.x));
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
          const left = Math.max(12, Math.min(window.innerWidth - 392, rect.left));
          const top = Math.max(12, Math.min(window.innerHeight - 200, rect.bottom + 12));
          card.style.left = left + 'px';
          card.style.top = top + 'px';
        }
        return;
      }
    }
    if (!card.dataset.moved) {
      card.style.left = '16px';
      card.style.top = '16px';
    }
  };
  place();
  window.addEventListener('scroll', place, true);
  window.addEventListener('resize', place);

  const send = (action) => {
    const note = shadow.querySelector('.note').value || '';
    try { chrome.runtime.sendMessage({ type: 'bb.help.resolved', requestId, action, note }); } catch { /* 忽略 */ }
    host.remove();
    hl.remove();
    roots.delete(host);
    window.removeEventListener('scroll', place, true);
    window.removeEventListener('resize', place);
  };
  shadow.querySelector('[data-act="done"]').addEventListener('click', () => send('done'));
  shadow.querySelector('[data-act="cancel"]').addEventListener('click', () => send('skip'));
  shadow.querySelector('.chev').addEventListener('click', () => {
    body.classList.toggle('hidden');
    const collapsed = body.classList.contains('hidden');
    const chev = shadow.querySelector('.chev');
    chev.textContent = collapsed ? '›' : '⌄';
    chev.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    chev.setAttribute('aria-label', collapsed ? T.expand : T.collapse);
    chev.title = collapsed ? T.expand : T.collapse;
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
export function installTakeover(info, lang, version, theme, texts) {
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
          try { installTakeover(info, lang, version, theme, texts); } catch { /* 忽略 */ }
        }
      });
    }
  } catch {
    // 页面环境拿不到 storage 时忽略，回退到 SW 侧同步
  }
  const existing = document.querySelector(UI_SELECTOR) || document.getElementById(LEGACY_ID);
  const apply = (root) => {
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
    if (primary) {
      primary.textContent = paused ? T.resume : T.pause;
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
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  paintTheme(host);
  if (themeQuery) {
    const themeListener = () => paintTheme(host);
    try { themeQuery.addEventListener('change', themeListener); } catch { try { themeQuery.addListener(themeListener); } catch { /* 忽略 */ } }
  }
  const shadow = host.attachShadow({ mode: 'closed' });
  roots.set(host, shadow);
  const style = document.createElement('style');
  style.textContent = [
    ':host{--bb-font:system-ui,-apple-system,"Segoe UI","PingFang SC","Noto Sans CJK SC",sans-serif}',
    '.glow{position:fixed;inset:0;z-index:2147483646;box-shadow:inset 0 0 20px 4px color-mix(in srgb,var(--bb-accent,#2f6fed) 28%,transparent),inset 0 0 0 3px color-mix(in srgb,var(--bb-accent,#2f6fed) 55%,transparent);pointer-events:none}',
    '.glow::after{content:"";position:absolute;inset:0;box-shadow:inset 0 0 48px 10px color-mix(in srgb,var(--bb-accent,#2f6fed) 55%,transparent);opacity:0;animation:bbp 3s ease-in-out infinite;pointer-events:none}',
    '@keyframes bbp{0%,100%{opacity:.15}50%{opacity:1}}',
    '.glow.paused::after{animation:none;opacity:0}',
    '@media (prefers-reduced-motion: reduce){.glow::after{animation:none;opacity:0}}',
    '.card{position:fixed;right:18px;bottom:18px;box-sizing:border-box;width:280px;max-width:calc(100vw - 28px);padding:14px;border:1px solid var(--bb-line,#dbe4f5);border-radius:16px;background:var(--bb-surface,#f7f9fc);color:var(--bb-fg,#1c2230);box-shadow:0 10px 28px var(--bb-shadow,rgba(28,34,48,.18)),0 2px 6px var(--bb-shadow,rgba(28,34,48,.18));font:12.5px/1.5 var(--bb-font);pointer-events:auto}',
    '.head{display:flex;align-items:center;gap:8px;margin-bottom:12px;cursor:grab;user-select:none}',
    '.head:active{cursor:grabbing}',
    '.logo{width:20px;height:20px;border-radius:6px;background:var(--bb-controller-accent,var(--bb-accent,#2f6fed));display:flex;align-items:center;justify-content:center;flex:0 0 auto}',
    '.logo svg{width:13px;height:13px;color:var(--bb-accent-fg,#fff)}',
    '.brand{flex:1;font-size:12.5px;font-weight:650;color:var(--bb-fg,#1c2230);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.pill{flex:0 0 auto;padding:2px 8px;border-radius:999px;background:var(--bb-accent-soft,#e8f0ff);color:var(--bb-accent-strong,#1d4ed8);font-size:10.5px;font-weight:600}',
    '.min{width:20px;height:20px;border:0;border-radius:6px;background:transparent;color:var(--bb-muted,#667085);cursor:pointer;font-size:14px;line-height:1;flex:0 0 auto}',
    '.status-row{display:flex;align-items:flex-start;gap:10px;margin-bottom:10px}',
    '.status-icon{width:34px;height:34px;border-radius:50%;background:var(--bb-accent-soft,#e8f0ff);color:var(--bb-accent-strong,#1d4ed8);display:flex;align-items:center;justify-content:center;flex:0 0 auto}',
    '.status-icon svg{width:17px;height:17px}',
    '.status-icon.paused{background:var(--bb-warn-bg,#fdeccd);color:var(--bb-warn-fg,#8a4b08)}',
    '.status-title{font-size:13px;font-weight:650;line-height:1.3;color:var(--bb-fg,#1c2230)}',
    '.status-sub{margin-top:2px;font-size:11px;color:var(--bb-muted,#667085);line-height:1.45}',
    '.session-row{display:flex;align-items:center;gap:8px;margin:2px 0 12px;font-size:11.5px;color:var(--bb-muted,#667085)}',
    '.session-row code{font:11px ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--bb-fg,#1c2230);background:var(--bb-accent-soft,#e8f0ff);border-radius:6px;padding:1px 6px}',
    '.actions{display:flex;gap:8px}',
    '.mini{position:fixed;right:18px;bottom:18px;display:none;align-items:center;gap:7px;padding:7px 12px;border:1px solid var(--bb-line,#dbe4f5);border-radius:999px;background:var(--bb-surface,#f7f9fc);color:var(--bb-fg,#1c2230);font:12px var(--bb-font);box-shadow:0 8px 22px var(--bb-shadow,rgba(28,34,48,.18));pointer-events:auto;cursor:pointer}',
    '.mini .dot{width:8px;height:8px;border-radius:50%;background:var(--bb-controller-accent,var(--bb-accent,#2f6fed))}',
    '.btn{flex:1;height:32px;border-radius:9px;border:1px solid var(--bb-line,#dbe4f5);background:var(--bb-surface-raised,#fff);color:var(--bb-fg,#1c2230);font-size:12px;font-weight:550;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px}',
    '.btn.primary{background:var(--bb-accent-soft,#e8f0ff);border-color:var(--bb-accent-line,#cfe0ff);color:var(--bb-accent-strong,#1d4ed8)}',
    '.btn:hover{filter:brightness(.98)}',
    '[data-act="stop"]{flex:0 0 96px}',
    'button:focus-visible{outline:2px solid var(--bb-accent,#2f6fed);outline-offset:2px}',
  ].join('');
  const wrap = document.createElement('div');
  wrap.innerHTML = '<div class="glow"></div>'
    + '<div class="card" role="region" aria-label="' + ((lang === 'zh' || lang === 'zh-TW') ? 'BridgeDeck 控制面板' : 'BridgeDeck control') + '">'
    + '<div class="head"><span class="logo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M3 17h18"/><path d="M6 17V9"/><path d="M18 17V9"/><path d="M6 9c3 4 9 4 12 0"/></svg></span><span class="brand">BridgeDeck</span><span class="pill">' + T.badge + '</span><button type="button" class="min" data-act="min" aria-label="' + ((lang === 'zh' || lang === 'zh-TW') ? '收起' : 'Minimize') + '" aria-expanded="true" title="' + (lang === 'en' ? 'Minimize' : '收起') + '">–</button></div>'
    + '<div class="status-row" role="status" aria-live="polite"><span class="status-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg></span>'
    + '<div><div class="status-title" data-status-title>' + T.controlling + '</div><div class="status-sub" data-status-sub>' + T.reading + '</div></div></div>'
    + '<div class="session-row" data-project-row style="display:none"><span>' + T.project + '</span><code data-project></code></div>'
    + '<div class="session-row" data-session-row style="display:none"><span>' + T.session + '</span><code data-session></code></div>'
    + '<div class="actions"><button type="button" class="btn primary" data-act="pause">' + T.pause + '</button><button type="button" class="btn" data-act="stop">' + T.stop + '</button></div>'
    + '</div>'
    + '<button type="button" class="mini" data-mini aria-label="' + T.mini + '" aria-expanded="false"><span class="dot"></span><span>' + T.mini + '</span><span aria-hidden="true">›</span></button>';
  shadow.appendChild(style);
  shadow.appendChild(wrap);
  
  document.documentElement.appendChild(host);

  const card = shadow.querySelector('.card');
  const mini = shadow.querySelector('[data-mini]');
  const minButton = shadow.querySelector('[data-act="min"]');
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
  };
  shadow.querySelector('[data-act="min"]').addEventListener('click', () => setMini(true));
  mini.addEventListener('click', () => setMini(false));
  const primary = shadow.querySelector('[data-act="pause"]');
  primary.addEventListener('click', () => {
    const next = primary.dataset.paused !== '1';
    info.paused = next;
    primary.dataset.paused = next ? '1' : '0';
    apply(shadow);
    try { chrome.runtime.sendMessage({ type: 'bb.takeover.pause', paused: next }); } catch { /* 忽略 */ }
  });
  const stopButton = shadow.querySelector('[data-act="stop"]');
  let stopArmed = false;
  let stopTimer = null;
  stopButton.addEventListener('click', () => {
    if (!stopArmed) {
      stopArmed = true;
      stopButton.textContent = T.confirmStop;
      const sub = shadow.querySelector('[data-status-sub]');
      if (sub) sub.textContent = T.stopConfirmSub;
      stopTimer = globalThis['set' + 'Timeout'](() => {
        stopArmed = false;
        stopButton.textContent = T.stop;
        apply(shadow);
      }, 3000);
      return;
    }
    if (stopTimer) globalThis['clear' + 'Timeout'](stopTimer);
    stopButton.disabled = true;
    stopButton.textContent = T.stopping;
    const sub = shadow.querySelector('[data-status-sub]');
    if (sub) sub.textContent = T.stopping;
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
