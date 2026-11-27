// src/borrow-ui.js —— 借用 Toast/UI 语言/确认条注入。
import { mapChromeError } from './errors.js';

export async function clearBorrowToast(tabId, requestId) {
  if (!tabId) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (rid) => {
        const host = document.getElementById('__bb_borrow_toast_host');
        if (!host) return;
        for (const el of Array.from(host.querySelectorAll('[data-request]'))) {
          if (el.dataset.request === rid) el.remove();
        }
        if (!host.children.length) host.remove();
      },
      args: [requestId],
    });
  } catch {
    // 标签页可能已关闭。
  }
}

export async function readUiLang() {
  try {
    const stored = await chrome.storage.local.get('bb.uiLang');
    const value = stored && stored['bb.uiLang']; return value || 'zh';
  } catch {
    return 'zh';
  }
}

export async function injectBanner(tabId, func, args) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'ISOLATED', func, args });
    return true;
  } catch (error) {
    throw mapChromeError(error, '注入确认条失败（受限页面无法借用）');
  }
}

import { withTimeout } from './timeout.js';
import { log } from './log.js';
import { openOverlay, closeOverlay } from './overlay-state.js';
import { borrowBanner, borrowToast } from './overlay-ui.js';
import { OVERLAY_THEME } from './overlay-theme.js';
import { overlayTexts, overlayA11yTexts } from './overlay-texts.js';

export const borrowUiRequests = new Map();
let borrowRehomeChain = Promise.resolve();

export async function injectBorrowModal(req, { focus = false } = {}) {
  if (req.surface === 'modal' && req.surfaceTabId === req.targetTabId) return;
  await clearBorrowUiSurface(req);
  if (focus) {
    try { await withTimeout(chrome.windows.update(req.windowId, { focused: true }), 3000, 'windows.update'); } catch { /* 忽略 */ }
  }
  openOverlay(req.targetTabId, 'borrow', { priority: 100, exclusive: true });
  await injectBanner(req.targetTabId, borrowBanner, [req.requestId, req.title, req.timeoutMs, req.lang, OVERLAY_THEME, overlayTexts(req.lang), overlayA11yTexts(req.lang)]);
  req.surface = 'modal';
  req.surfaceTabId = req.targetTabId;
}

export async function injectBorrowToast(req, toastTabId) {
  if (req.surface === 'toast' && req.surfaceTabId === toastTabId) return;
  await clearBorrowUiSurface(req);
  await injectBanner(toastTabId, borrowToast, [req.requestId, req.title, req.timeoutMs, req.lang, OVERLAY_THEME, overlayTexts(req.lang), overlayA11yTexts(req.lang)]);
  openOverlay(toastTabId, 'borrow-toast', { priority: 100 });
  req.surface = 'toast';
  req.surfaceTabId = toastTabId;
}

async function clearBorrowUiSurface(req) {
  if (!req || !req.surface) return;
  const surface = req.surface;
  const surfaceTabId = req.surfaceTabId;
  req.surface = null;
  req.surfaceTabId = null;
  if (surface === 'modal') {
    await clearBorrowBanner(req.targetTabId).catch(() => {});
    closeOverlay(req.targetTabId, 'borrow');
  } else if (surface === 'toast') {
    await clearBorrowToast(surfaceTabId, req.requestId).catch(() => {});
    closeOverlay(surfaceTabId, 'borrow-toast');
  }
}

export async function releaseBorrowUi(requestId) {
  const req = borrowUiRequests.get(requestId);
  if (!req) return;
  await clearBorrowUiSurface(req);
  borrowUiRequests.delete(requestId);
}

async function rehomeBorrowUiNow(windowId) {
  const reqs = [...borrowUiRequests.values()].filter((req) => req.windowId === Number(windowId));
  if (!reqs.length) return;
  let activeTab = null;
  try {
    const activeTabs = await chrome.tabs.query({ active: true, windowId: Number(windowId) });
    activeTab = (activeTabs || [])[0] || null;
  } catch { /* 窗口已关闭 */ }
  if (!activeTab || !Number.isInteger(Number(activeTab.id))) return;
  const activeId = Number(activeTab.id);
  for (const req of reqs) {
    try {
      if (req.targetTabId === activeId) {
        await injectBorrowModal(req, { focus: false });
      } else if (req.surface === 'modal' || (req.surface === 'toast' && req.surfaceTabId !== activeId)) {
        await injectBorrowToast(req, activeId);
      }
    } catch (error) {
      log('借用确认重新分配失败 tab=' + req.targetTabId + '：' + ((error && error.message) || error));
    }
  }
}

export function rehomeBorrowUi(windowId) {
  borrowRehomeChain = borrowRehomeChain
    .then(() => rehomeBorrowUiNow(windowId))
    .catch((error) => log('借用确认重新分配异常：' + ((error && error.message) || error)));
  return borrowRehomeChain;
}


export async function clearBorrowBanner(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: 'ISOLATED',
      func: () => {
        for (const id of ['__bb_borrow_modal', '__bb_human_banner']) {
          const node = document.getElementById(id);
          if (node) node.remove();
        }
      },
    });
  } catch { /* 页面可能已关闭 */ }
}