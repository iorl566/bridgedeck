// src/record-overlay.js —— 页面内“正在录制你的操作”浮层
import { log } from './log.js';
import { closeOverlay, isCapturing, openOverlay } from './overlay-state.js';
import { OVERLAY_THEME } from './overlay-theme.js';
import { overlayTexts, overlayA11yTexts } from './overlay-texts.js';
// 统一执行期状态 chip（录制/截图中/录制视频）由 status-chip 提供；录制浮层保持自身实现，
// video/longshot 可复用同一组件。
export { installStatusChip } from './status-chip.js';

export function installRecordOverlay(startedAt, lang, theme, texts, a11y) {
  const BASE = lang === 'en'
    ? { label: 'Recording your actions', finish: 'Finish' }
    : { label: '正在录制你的操作', finish: '结束' };
  const T = { ...BASE, ...(texts?.record || {}) };
  // 播报/标签动态文案：SW 侧按界面语言查动态文案 catalog 后传入（缺省回退语言包）。
  const A = (a11y && typeof a11y === 'object' && a11y.record && typeof a11y.record === 'object') ? a11y.record : {};
  const ID = '__bb_record_host';
  const old = document.getElementById(ID);
  if (old) old.remove();
  const previousFocus = document.activeElement;
  const host = document.createElement('div');
  host.id = ID;
  host.setAttribute('dir', /^(ar|he|fa|ur|yi|dv|ps|sd|ug|ckb)\b/i.test(String(lang || '')) || document.documentElement.dir === 'rtl' ? 'rtl' : 'ltr');
  // 录制提示是“页面状态”：role=status + aria-live 让屏幕阅读器在开始/结束时播报，
  // 不抢页面焦点（aria-modal 不适用，用户仍可操作页面）。
  host.setAttribute('role', 'status');
  host.setAttribute('aria-live', 'polite');
  host.setAttribute('aria-label', A.label || T.label);
  host.setAttribute('aria-keyshortcuts', 'Escape');
  const forced = document.documentElement.getAttribute('data-bb-theme');
  const dark = forced === 'dark' || (forced !== 'light' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const tokens = (theme && theme[dark ? 'dark' : 'light']) || {};
  host.setAttribute('data-bb-theme', dark ? 'dark' : 'light');
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  for (const [key, value] of Object.entries(tokens)) host.style.setProperty(key, value);
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = [
    '.pill{position:fixed;inset-inline:0;margin-inline:auto;width:max-content;bottom:18px;display:flex;align-items:center;gap:9px;padding:8px 10px 8px 12px;border-radius:999px;background:var(--bb-surface,#1c2230);color:var(--bb-fg,#fff);font:12px/1.4 system-ui,sans-serif;box-shadow:0 10px 26px var(--bb-shadow-strong,rgba(16,24,40,.28));pointer-events:auto;cursor:grab;user-select:none}',
    '.dot{width:8px;height:8px;border-radius:50%;background:#ef4444;box-shadow:0 0 0 3px rgba(239,68,68,.22);animation:bbpulse 1.6s ease-in-out infinite}',
    '@keyframes bbpulse{0%,100%{opacity:1}50%{opacity:.45}}',
    '.time{font:11px ui-monospace,SFMono-Regular,Consolas,monospace;opacity:.8;min-width:42px}',
    '.finish{height:24px;padding:0 10px;border:0;border-radius:999px;background:#ef4444;color:#fff;font-size:11px;font-weight:600;cursor:pointer}',
    '.sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}',
    'button:focus-visible{outline:2px solid var(--bb-accent,#2f6fed);outline-offset:2px}',
  ].join('');
  const wrap = document.createElement('div');
  wrap.innerHTML = '<div class="pill"><span class="dot"></span><span>' + T.label + '</span><span class="time"></span><button class="finish">' + T.finish + '</button>'
    + '<span class="sr" data-a11y-hint></span><span class="sr" data-a11y-live role="status" aria-live="polite"></span></div>';
  shadow.appendChild(style);
  shadow.appendChild(wrap);
  document.documentElement.appendChild(host);
  const srHint = shadow.querySelector('[data-a11y-hint]');
  const srLive = shadow.querySelector('[data-a11y-live]');
  if (srHint) srHint.textContent = A.escHint || ('Esc · ' + T.finish);
  if (srLive) srLive.textContent = A.start || ((lang === 'en') ? 'Recording your actions; press Esc to finish' : '正在录制你的操作，按 Esc 结束');

  const pill = shadow.querySelector('.pill');
  const time = shadow.querySelector('.time');
  const started = Number(startedAt) || Date.now();
  const tick = () => {
    const secs = Math.max(0, Math.floor((Date.now() - started) / 1000));
    const mm = String(Math.floor(secs / 60)).padStart(2, '0');
    const ss = String(secs % 60).padStart(2, '0');
    time.textContent = mm + ':' + ss;
  };
  tick();
  const timer = globalThis['set' + 'Interval'](tick, 1000);
  const restoreFocus = () => {
    try {
      if (previousFocus && previousFocus.isConnected !== false && typeof previousFocus.focus === 'function') {
        previousFocus.focus({ preventScroll: true });
      }
    } catch { /* 原焦点节点可能已移除 */ }
  };
  const remove = () => {
    globalThis['clear' + 'Interval'](timer);
    host.remove();
    restoreFocus();
  };
  const finishRecording = () => {
    if (!host.isConnected) return;
    if (srLive && A.finished) srLive.textContent = A.finished;
    remove();
    try { chrome.runtime.sendMessage({ type: 'bb.record.finish' }); } catch { /* 忽略 */ }
  };
  shadow.querySelector('.finish').addEventListener('click', finishRecording);
  // Esc 结束录制（焦点在胶囊内时生效，不劫持页面自身的 Esc）。
  pill.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    finishRecording();
  });

  let drag = null;
  pill.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button')) return;
    const rect = pill.getBoundingClientRect();
    drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
    pill.style.insetInlineStart = 'auto';
    pill.style.bottom = 'auto';
    pill.style.left = rect.left + 'px';
    pill.style.top = rect.top + 'px';
    pill.setPointerCapture(event.pointerId);
  });
  pill.addEventListener('pointermove', (event) => {
    if (!drag) return;
    pill.style.left = Math.max(4, Math.min(window.innerWidth - pill.offsetWidth - 4, event.clientX - drag.dx)) + 'px';
    pill.style.top = Math.max(4, Math.min(window.innerHeight - pill.offsetHeight - 4, event.clientY - drag.dy)) + 'px';
  });
  pill.addEventListener('pointerup', () => { drag = null; });
}

async function readUiLang() {
  try {
    const stored = await chrome.storage.local.get('bb.uiLang');
    const value = stored && stored['bb.uiLang']; return value || 'zh';
  } catch {
    return 'zh';
  }
}

export async function showRecordOverlay(tabId, startedAt = Date.now()) {
  if (isCapturing(tabId)) return;
  openOverlay(tabId, 'record', { priority: 5 });
  try {
    const lang = await readUiLang();
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: installRecordOverlay, args: [Number(startedAt) || Date.now(), lang, OVERLAY_THEME, overlayTexts(lang), overlayA11yTexts(lang)] });
  } catch (error) {
    log('录制浮层注入失败 tab=' + tabId + '：' + ((error && error.message) || error));
  }
}

export async function hideRecordOverlay(tabId) {
  closeOverlay(tabId, 'record');
  try {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: () => { const n = document.getElementById('__bb_record_host'); if (n) n.remove(); } });
  } catch {
    // 页面可能已关闭
  }
}
