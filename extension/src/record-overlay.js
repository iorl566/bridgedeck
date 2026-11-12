// src/record-overlay.js —— 页面内“正在录制你的操作”浮层
import { log } from './log.js';
import { closeOverlay, isCapturing, openOverlay } from './overlay-state.js';

function installRecordOverlay(startedAt, lang) {
  const T = lang === 'en'
    ? { label: 'Recording your actions', finish: 'Finish' }
    : { label: '正在录制你的操作', finish: '结束' };
  const ID = '__bb_record_host';
  const old = document.getElementById(ID);
  if (old) old.remove();
  const host = document.createElement('div');
  host.id = ID;
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = [
    '.pill{position:fixed;left:18px;bottom:18px;display:flex;align-items:center;gap:9px;padding:8px 10px 8px 12px;border-radius:999px;background:#1c2230;color:#fff;font:12px/1.4 system-ui,sans-serif;box-shadow:0 10px 26px rgba(16,24,40,.28);pointer-events:auto;cursor:grab;user-select:none}',
    '.dot{width:8px;height:8px;border-radius:50%;background:#ef4444;box-shadow:0 0 0 3px rgba(239,68,68,.22);animation:bbpulse 1.6s ease-in-out infinite}',
    '@keyframes bbpulse{0%,100%{opacity:1}50%{opacity:.45}}',
    '.time{font:11px ui-monospace,SFMono-Regular,Consolas,monospace;opacity:.8;min-width:42px}',
    '.finish{height:24px;padding:0 10px;border:0;border-radius:999px;background:#ef4444;color:#fff;font-size:11px;font-weight:600;cursor:pointer}',
  ].join('');
  const wrap = document.createElement('div');
  wrap.innerHTML = '<div class="pill"><span class="dot"></span><span>' + T.label + '</span><span class="time"></span><button class="finish">' + T.finish + '</button></div>';
  shadow.appendChild(style);
  shadow.appendChild(wrap);
  document.documentElement.appendChild(host);

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
  const remove = () => {
    globalThis['clear' + 'Interval'](timer);
    host.remove();
  };
  shadow.querySelector('.finish').addEventListener('click', () => {
    remove();
    try { chrome.runtime.sendMessage({ type: 'bb.record.finish' }); } catch { /* 忽略 */ }
  });

  let drag = null;
  pill.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button')) return;
    const rect = pill.getBoundingClientRect();
    drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
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
    return stored && stored['bb.uiLang'] === 'en' ? 'en' : 'zh';
  } catch {
    return 'zh';
  }
}

export async function showRecordOverlay(tabId, startedAt = Date.now()) {
  if (isCapturing(tabId)) return;
  openOverlay(tabId, 'record', { priority: 5 });
  try {
    const lang = await readUiLang();
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: installRecordOverlay, args: [Number(startedAt) || Date.now(), lang] });
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
