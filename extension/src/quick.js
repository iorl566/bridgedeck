// src/quick.js —— 弹窗快捷功能：可见/整页截图、手动拼接、状态汇总
import { blobToDataUrl, pngSize, takeScreenshot } from './screenshot.js';
import { readSettings } from './settings.js';
import { log } from './log.js';
import { debugTasks } from './debug.js';
import { OVERLAY_THEME } from './overlay-theme.js';
import { manualOverlayFunc } from './manual-overlay.js';
import { overlayTexts } from './overlay-texts.js';

const MANUAL_LIMIT = 20;
const STITCH_MAX_HEIGHT = 20000;

const manual = { tabId: null, frames: [], startedAt: 0 };

async function readUiLang() {
  try {
    const stored = await chrome.storage.local.get('bb.uiLang');
    return (stored && stored['bb.uiLang']) || 'zh';
  } catch {
    return 'zh';
  }
}

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

async function activeTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs[0];
  if (!tab || !Number.isInteger(tab.id)) throw new Error('找不到当前标签页');
  const url = tab.url || '';
  if (/^(chrome|edge|about|devtools|chrome-extension|view-source):/i.test(url)) {
    throw new Error('当前页面不允许截图（' + url.split(':')[0] + ':// 受限页面）');
  }
  return tab.id;
}

export async function saveDataUrl(dataUrl, prefix) {
  const filename = 'browser-bridge/' + prefix + '-' + stamp() + '.png';
  await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
  return filename;
}

/** 可见区域 / 自动滚动整页截图。preview=true 时只返回 dataUrl，不落盘。 */
export async function capture(mode, options) {
  const preview = options && options.preview === true;
  const tabId = Number.isInteger(options && options.tabId) ? options.tabId : await activeTabId();
  const shot = mode === 'auto'
    ? await takeScreenshot({ tabId, fullPage: true })
    : await takeScreenshot({ tabId, fullPage: false });
  if (preview) {
    return { ok: true, dataUrl: shot.dataUrl, width: shot.width, height: shot.height };
  }
  const filename = await saveDataUrl(shot.dataUrl, mode === 'auto' ? 'page' : 'view');
  log('快捷截图 ' + mode + ' ' + shot.width + 'x' + shot.height + ' -> ' + filename);
  return { ok: true, filename, width: shot.width, height: shot.height };
}

/** 把 dataUrl 存到浏览器下载目录（长截图预览后的「保存」用）。 */
export async function saveDataUrlImage(dataUrl, prefix) {
  const filename = await saveDataUrl(dataUrl, prefix || 'shot');
  return { ok: true, filename };
}

/** 手动拼接：开始 / 拍一帧 / 保存。 */
export async function showManualOverlay(tabId, frames = 0) {
  try {
    const lang = await readUiLang();
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: manualOverlayFunc, args: [Number(frames) || 0, lang, OVERLAY_THEME, overlayTexts(lang)] });
  } catch {
    // 页面不可注入时忽略
  }
}

export async function hideManualOverlay(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: () => { const n = document.getElementById('__bb_manual_host'); if (n) n.remove(); } });
  } catch {
    // 忽略
  }
}

export async function manualStart(params = {}) {
  const tabId = Number.isInteger(params.tabId) ? params.tabId : await activeTabId();
  manual.tabId = tabId;
  manual.frames = [];
  manual.startedAt = Date.now();
  if (Number.isInteger(tabId)) await showManualOverlay(tabId, 0).catch(() => {});
  return { ok: true, frames: 0 };
}

export async function manualFrame(params = {}) {
  const tabId = Number.isInteger(params.tabId)
    ? params.tabId
    : (manual.tabId != null ? manual.tabId : await activeTabId());
  if (manual.frames.length >= MANUAL_LIMIT) {
    return { ok: false, error: '手动拼接最多 ' + MANUAL_LIMIT + ' 帧，请先保存' };
  }
  const shot = await takeScreenshot({ tabId, fullPage: false });
  manual.tabId = tabId;
  manual.frames.push({ dataUrl: shot.dataUrl, width: shot.width, height: shot.height });
  await showManualOverlay(tabId, manual.frames.length).catch(() => {});
  return { ok: true, frames: manual.frames.length, width: shot.width, height: shot.height };
}

/** 拼接全部帧，返回 dataUrl；落盘交给调用方（弹窗走 downloads，CLI 直接写文件）。 */
export async function manualSave() {
  if (!manual.frames.length) return { ok: false, error: '还没有拍到帧' };
  const bitmaps = [];
  let width = 0;
  let height = 0;
  for (const frame of manual.frames) {
    const blob = await (await fetch(frame.dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    bitmaps.push(bitmap);
    width = Math.max(width, bitmap.width);
    height += bitmap.height;
  }
  const canvasHeight = Math.min(height, STITCH_MAX_HEIGHT);
  const canvas = new OffscreenCanvas(Math.max(1, width), Math.max(1, canvasHeight));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  let y = 0;
  for (const bitmap of bitmaps) {
    if (y >= canvasHeight) { bitmap.close(); continue; }
    ctx.drawImage(bitmap, 0, y);
    y += bitmap.height;
    bitmap.close();
  }
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const dataUrl = await blobToDataUrl(blob);
  const size = pngSize(dataUrl);
  const frames = manual.frames.length;
  const overlayTab = manual.tabId;
  manual.frames = [];
  manual.tabId = null;
  if (Number.isInteger(overlayTab)) await hideManualOverlay(overlayTab).catch(() => {});
  return { ok: true, dataUrl, frames, width: size.width, height: size.height };
}

/** 弹窗状态：连接 + 实例 + 受控标签页 + 设置 + 通知。 */
export async function popupState(socket) {
  const settings = await readSettings();
  const storedNotify = await chrome.storage.local.get('bb.notifications').catch(() => ({}));
  const notifications = Array.isArray(storedNotify && storedNotify['bb.notifications'])
    ? storedNotify['bb.notifications']
    : [];
  const stored = await chrome.storage.session.get('bb.controlledTabs').catch(() => ({}));
  const controlled = Array.isArray(stored && stored['bb.controlledTabs']) ? stored['bb.controlledTabs'] : [];
  let tabs = [];
  try {
    const all = await chrome.tabs.query({});
    const byId = new Map(all.map((tab) => [tab.id, tab]));
    tabs = controlled
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((tab) => ({ tabId: tab.id, windowId: tab.windowId, url: tab.url || '', title: tab.title || '' }));
  } catch {
    tabs = [];
  }
  const debugActive = debugTasks().map((item) => ({
    title: item.title || item.url || ('标签页 ' + item.tabId),
    meta: '网站调试 · 采集中' + (item.bodies ? ' · 记录正文' : ''),
    url: chrome.runtime.getURL('ui/debug.html'),
    debug: true,
    tabId: item.tabId,
  }));
  const connection = socket && typeof socket.getSnapshot === 'function' ? socket.getSnapshot() : {};
  return {
    ok: true,
    tasks: debugActive,
    connectionState: connection.connectionState || null,
    protocol: connection.protocol || null,
    protocolSkew: connection.protocolSkew || null,
    retryCount: connection.retryCount || 0,
    localAuth: socket && socket.localAuth ? socket.localAuth : null,
    lastError: socket && socket.lastError ? socket.lastError : null,
    connected: Boolean(socket && socket.isOpen() && socket.helloDone),
    instanceId: socket ? socket.instanceId : null,
    daemonVersion: socket ? socket.daemonVersion : null,
    port: socket ? socket.port : null,
    label: settings.instanceLabel,
    sessions: tabs,
    settings,
    extVersion: chrome.runtime.getManifest().version,
    cliVersion: socket ? socket.daemonVersion : null,
    notifications,
  };
}
