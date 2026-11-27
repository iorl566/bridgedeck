// src/manual-overlay.js —— 手动长截图浮层（独立模块，便于 DOM 测试与主题复用）
export function manualOverlayFunc(initialFrames, lang, theme, texts) {
  const BASE = lang === 'en'
    ? { label: 'Manual full-page', frame: 'Capture frame', done: 'Done', cancel: 'Cancel', frames: ' frames' }
    : { label: '手动长截图', frame: '拍一帧', done: '完成', cancel: '取消', frames: ' 帧' };
  const T = { ...BASE, ...(texts?.manual || {}) };
  const ID = '__bb_manual_host';
  const old = document.getElementById(ID);
  if (old) old.remove();
  const previousFocus = document.activeElement;
  const host = document.createElement('div');
  host.id = ID;
  host.setAttribute('dir', /^(ar|he|fa|ur|yi|dv|ps|sd|ug|ckb)\b/i.test(String(lang || '')) || document.documentElement.dir === 'rtl' ? 'rtl' : 'ltr');
  // 手动长截图是“采集工具面板”：用非模态 dialog 语义（页面仍可滚动），
  // 焦点陷阱不适用于工具面板，但 Esc 必须等价于取消。
  host.setAttribute('role', 'dialog');
  host.setAttribute('aria-label', T.label);
  host.setAttribute('aria-keyshortcuts', 'Escape');
  const forced = document.documentElement.getAttribute('data-bb-theme');
  const dark = forced === 'dark' || (forced !== 'light' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const tokens = (theme && theme[dark ? 'dark' : 'light']) || {};
  host.setAttribute('data-bb-theme', dark ? 'dark' : 'light');
  host.style.cssText = 'position:fixed;inset-inline-start:18px;bottom:18px;z-index:2147483647;pointer-events:none';
  for (const [key, value] of Object.entries(tokens)) host.style.setProperty(key, value);
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = [
    '.pill{display:flex;align-items:center;gap:8px;padding:8px 10px 8px 12px;border-radius:999px;background:var(--bb-surface,#1c2230);color:var(--bb-fg,#fff);font:12px/1.4 system-ui,sans-serif;box-shadow:0 10px 26px var(--bb-shadow-strong,rgba(16,24,40,.28));pointer-events:auto;cursor:grab}',
    '.dot{width:8px;height:8px;border-radius:50%;background:#2f6fed;box-shadow:0 0 0 3px rgba(47,111,237,.22)}',
    '.count{font:11px ui-monospace,Consolas,monospace;opacity:.8}',
    'button{height:24px;padding:0 9px;border:0;border-radius:999px;font-size:11px;font-weight:600;cursor:pointer}',
    '.frame{background:#2f6fed;color:#fff}',
    '.done{background:#16a34a;color:#fff}',
    '.cancel{background:#374151;color:#e5e7eb}',
    '.sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}',
    'button:focus-visible{outline:2px solid var(--bb-accent,#2f6fed);outline-offset:2px}',
  ].join('');
  const wrap = document.createElement('div');
  wrap.innerHTML = '<div class="pill"><span class="dot"></span><span>' + T.label + '</span><span class="count">0' + T.frames + '</span><button class="frame">' + T.frame + '</button><button class="done">' + T.done + '</button><button class="cancel">' + T.cancel + '</button>'
    + '<span class="sr" data-a11y-hint></span><span class="sr" data-a11y-live role="status" aria-live="polite"></span></div>';
  shadow.appendChild(style);
  shadow.appendChild(wrap);
  document.documentElement.appendChild(host);
  const count = shadow.querySelector('.count');
  const srHint = shadow.querySelector('[data-a11y-hint]');
  const srLive = shadow.querySelector('[data-a11y-live]');
  // Esc / 取消按钮的提示用语言包里已有的动作名组合，12 语言都不需要新增翻译。
  if (srHint) srHint.textContent = 'Esc · ' + T.cancel;
  const announce = (text) => { if (srLive && text) srLive.textContent = text; };
  const restoreFocus = () => {
    try {
      if (previousFocus && previousFocus.isConnected !== false && typeof previousFocus.focus === 'function') {
        previousFocus.focus({ preventScroll: true });
      }
    } catch { /* 原焦点节点可能已移除 */ }
  };
  const close = () => {
    host.remove();
    restoreFocus();
  };
  count.textContent = (Number(initialFrames) || 0) + T.frames;
  const send = (type) => new Promise((resolve) => {
    try { chrome.runtime.sendMessage({ type }, (reply) => resolve(reply || {})); } catch { resolve({}); }
  });
  shadow.querySelector('.frame').addEventListener('click', async () => {
    const reply = await send('bb.manual.frame');
    if (reply && reply.ok !== false) {
      count.textContent = (reply.frames || 0) + T.frames;
      announce(T.frame + ' · ' + count.textContent);
    }
  });
  shadow.querySelector('.done').addEventListener('click', async () => {
    const reply = await send('bb.manual.finish');
    if (reply && reply.ok !== false) close();
  });
  shadow.querySelector('.cancel').addEventListener('click', async () => {
    await send('bb.manual.cancel');
    close();
  });
  // Esc 取消（焦点在工具面板内时生效）。
  shadow.querySelector('.pill').addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    send('bb.manual.cancel');
    close();
  });
}

async function readUiLang() {
  try {
    const stored = await chrome.storage.local.get('bb.uiLang');
    const value = stored && stored['bb.uiLang']; return value || 'zh';
  } catch {
    return 'zh';
  }
}
