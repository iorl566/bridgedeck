// src/takeover.js —— Agent 接管浮层（BridgeDeck蓝配色）
import { log } from './log.js';
import { closeOverlay, isCapturing, openOverlay } from './overlay-state.js';

const takeoverStates = new Map();
const takeoverVersions = new Map();

export function setTakeoverState(tabId, patch) {
  const next = { ...(takeoverStates.get(tabId) || {}), ...(patch || {}) };
  takeoverStates.set(tabId, next);
  return next;
}

export function getTakeoverState(tabId) {
  return takeoverStates.get(tabId) || {};
}

export function clearTakeoverState(tabId) {
  takeoverStates.delete(tabId);
}

function installTakeover(info, lang, version) {
  const nextVersion = Number(version) || 0;
  const currentVersion = Number(window.__bbTakeoverVersion) || 0;
  if (nextVersion && nextVersion < currentVersion) return;
  if (nextVersion) window.__bbTakeoverVersion = nextVersion;
  const T = lang === 'en' ? {
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
    stopping: '正在停止任务…',
    mini: 'Agent 控制中',
    project: '项目',
    session: '会话',
    badge: '人机协作',
    controlling: 'Agent 正在控制',
    reading: '正在读取最新页面状态',
  };
  const ID = '__bb_takeover_host';
  const existing = document.getElementById(ID);
  const apply = (root) => {
    const session = String(info.sessionId || '');
    const paused = info.paused === true;
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
    if (projectRow) projectRow.style.display = info.project ? '' : 'none';
    if (projectCode) projectCode.textContent = String(info.project || '');
    if (sessionRow) sessionRow.style.display = session ? '' : 'none';
    if (sessionCode) sessionCode.textContent = session;
    if (title) title.textContent = modeText[0];
    if (sub) sub.textContent = info.borrowed && mode !== 'held' ? T.borrowed : modeText[1];
    if (primary) {
      primary.textContent = paused ? T.resume : T.pause;
      primary.dataset.paused = paused ? '1' : '0';
    }
    root.querySelector('.status-icon').classList.toggle('paused', paused);
  };

  if (existing && existing.shadowRoot) {
    apply(existing.shadowRoot);
    return;
  }
  const host = document.createElement('div');
  host.id = ID;
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = [
    '.glow{position:fixed;inset:0;border-radius:10px;box-shadow:inset 0 0 0 2px rgba(47,111,237,.40),inset 0 0 24px rgba(47,111,237,.14);animation:bbp 3s ease-in-out infinite;pointer-events:none}',
    '@keyframes bbp{0%,100%{opacity:.45}50%{opacity:.9}}',
    '.card{position:fixed;right:18px;bottom:18px;box-sizing:border-box;width:280px;max-width:calc(100vw - 28px);padding:14px;border:1px solid #dbe4f5;border-radius:16px;background:#f7f9fc;color:#1c2230;box-shadow:0 10px 28px rgba(28,34,48,.14),0 2px 6px rgba(28,34,48,.08);font:12.5px/1.5 system-ui,sans-serif;pointer-events:auto}',
    '.head{display:flex;align-items:center;gap:8px;margin-bottom:12px;cursor:grab;user-select:none}',
    '.head:active{cursor:grabbing}',
    '.logo{width:20px;height:20px;border-radius:6px;background:#2f6fed;display:flex;align-items:center;justify-content:center;flex:0 0 auto}',
    '.logo svg{width:13px;height:13px;color:#fff}',
    '.brand{flex:1;font-size:12.5px;font-weight:650;color:#1c2230;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.pill{flex:0 0 auto;padding:2px 8px;border-radius:999px;background:#e8f0ff;color:#2f6fed;font-size:10.5px;font-weight:600}',
    '.min{width:20px;height:20px;border:0;border-radius:6px;background:transparent;color:#6b7488;cursor:pointer;font-size:14px;line-height:1;flex:0 0 auto}',
    '.status-row{display:flex;align-items:flex-start;gap:10px;margin-bottom:10px}',
    '.status-icon{width:34px;height:34px;border-radius:50%;background:#e8f0ff;color:#2f6fed;display:flex;align-items:center;justify-content:center;flex:0 0 auto}',
    '.status-icon svg{width:17px;height:17px}',
    '.status-icon.paused{background:#fdeccd;color:#b45309}',
    '.status-title{font-size:13px;font-weight:650;line-height:1.3}',
    '.status-sub{margin-top:2px;font-size:11px;color:#6b7488;line-height:1.45}',
    '.session-row{display:flex;align-items:center;gap:8px;margin:2px 0 12px;font-size:11.5px;color:#6b7488}',
    '.session-row code{font:11px ui-monospace,SFMono-Regular,Consolas,monospace;color:#1c2230;background:#eef2fa;border-radius:6px;padding:1px 6px}',
    '.actions{display:flex;gap:8px}',
    '.mini{position:fixed;right:18px;bottom:18px;display:none;align-items:center;gap:7px;padding:7px 12px;border:1px solid #dbe4f5;border-radius:999px;background:#f7f9fc;color:#1c2230;font:12px system-ui,sans-serif;box-shadow:0 8px 22px rgba(28,34,48,.16);pointer-events:auto;cursor:pointer}',
    '.mini .dot{width:8px;height:8px;border-radius:50%;background:#2f6fed}',
    '.btn{flex:1;height:32px;border-radius:9px;border:1px solid #dbe4f5;background:#fff;color:#1c2230;font-size:12px;font-weight:550;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px}',
    '.btn.primary{background:#e8f0ff;border-color:#cfe0ff;color:#2f6fed}',
    '.btn:hover{filter:brightness(.98)}',
    '[data-act="stop"]{flex:0 0 96px}',
  ].join('');
  const wrap = document.createElement('div');
  wrap.innerHTML = '<div class="glow"></div>'
    + '<div class="card">'
    + '<div class="head"><span class="logo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M3 17h18"/><path d="M6 17V9"/><path d="M18 17V9"/><path d="M6 9c3 4 9 4 12 0"/></svg></span><span class="brand">BridgeDeck</span><span class="pill">' + T.badge + '</span><button class="min" data-act="min" title="' + (lang === 'en' ? 'Minimize' : '收起') + '">–</button></div>'
    + '<div class="status-row"><span class="status-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg></span>'
    + '<div><div class="status-title" data-status-title>' + T.controlling + '</div><div class="status-sub" data-status-sub>' + T.reading + '</div></div></div>'
    + '<div class="session-row" data-project-row style="display:none"><span>' + T.project + '</span><code data-project></code></div>'
    + '<div class="session-row" data-session-row style="display:none"><span>' + T.session + '</span><code data-session></code></div>'
    + '<div class="actions"><button class="btn primary" data-act="pause">' + T.pause + '</button><button class="btn" data-act="stop">' + T.stop + '</button></div>'
    + '</div>'
    + '<button class="mini" data-mini><span class="dot"></span><span>' + T.mini + '</span><span aria-hidden="true">›</span></button>';
  shadow.appendChild(style);
  shadow.appendChild(wrap);
  document.documentElement.appendChild(host);

  const card = shadow.querySelector('.card');
  const mini = shadow.querySelector('[data-mini]');
  const setMini = (on) => {
    card.style.display = on ? 'none' : '';
    shadow.querySelector('.glow').style.display = on ? 'none' : '';
    mini.style.display = on ? 'inline-flex' : 'none';
    try { sessionStorage.setItem('__bb_takeover_state.min', on ? '1' : '0'); } catch { /* 忽略 */ }
  };
  shadow.querySelector('[data-act="min"]').addEventListener('click', () => setMini(true));
  mini.addEventListener('click', () => setMini(false));
  try { if (sessionStorage.getItem('__bb_takeover_state.min') === '1') setMini(true); } catch { /* 忽略 */ }
  const primary = shadow.querySelector('[data-act="pause"]');
  primary.addEventListener('click', () => {
    const next = primary.dataset.paused !== '1';
    primary.dataset.paused = next ? '1' : '0';
    apply(shadow);
    try { chrome.runtime.sendMessage({ type: 'bb.takeover.pause', paused: next }); } catch { /* 忽略 */ }
  });
  shadow.querySelector('[data-act="stop"]').addEventListener('click', () => {
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
  const showHuman = (editing) => {
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
    return path.some((node) => node && node.id === '__bb_takeover_host');
  };
  document.addEventListener('pointerdown', (event) => { if (!inOverlay(event)) showHuman(false); }, true);
  document.addEventListener('keydown', (event) => { if (!inOverlay(event)) showHuman(false); }, true);
  document.addEventListener('focusin', (event) => {
    const tag = event.target && event.target.tagName ? String(event.target.tagName).toUpperCase() : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (event.target && event.target.isContentEditable)) showHuman(true);
  }, true);
}

async function readUiLang() {
  try {
    const stored = await chrome.storage.local.get('bb.uiLang');
    return stored && stored['bb.uiLang'] === 'en' ? 'en' : 'zh';
  } catch {
    return 'zh';
  }
}

export async function showTakeover(tabId, info = {}) {
  const merged = { ...getTakeoverState(tabId), ...(info || {}) };
  info = merged;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!/^https?:/i.test(tab.url || '')) return;
  } catch {
    return;
  }
  if (isCapturing(tabId)) return;
  openOverlay(tabId, 'takeover', { priority: 10 });
  const lang = await readUiLang();
  takeoverVersions.set(tabId, (takeoverVersions.get(tabId) || 0) + 1);
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: installTakeover,
      args: [{ sessionId: info.sessionId || '', project: info.project || '', paused: info.paused === true, borrowed: info.borrowed === true }, lang, (takeoverVersions.get(tabId) || 0) + 1],
    });
  } catch (error) {
    log('接管浮层注入失败 tab=' + tabId + '：' + ((error && error.message) || error));
  }
}

export async function hideTakeover(tabId) {
  closeOverlay(tabId, 'takeover');
  clearTakeoverState(tabId);
  takeoverVersions.set(tabId, (takeoverVersions.get(tabId) || 0) + 1);
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: () => { window.__bbTakeoverVersion = (Number(window.__bbTakeoverVersion) || 0) + 1; const n = document.getElementById('__bb_takeover_host'); if (n) n.remove(); } });
  } catch {
    // 页面可能已关闭
  }
}
