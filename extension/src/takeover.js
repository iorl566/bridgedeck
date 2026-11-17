// src/takeover.js —— Agent 接管浮层（BridgeDeck蓝配色）
import { log } from './log.js';
import { readSettings } from './settings.js';
import { closeOverlay, isCapturing, openOverlay } from './overlay-state.js';
import { installTakeover } from './overlay-ui.js';
import { overlayTexts } from './overlay-texts.js';
import { OVERLAY_THEME } from './overlay-theme.js';
import { setCooperationBlocked } from './cooperation.js';
import { controlGeneration } from './control.js';

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


async function readUiLang() {
  try {
    const stored = await chrome.storage.local.get('bb.uiLang');
    const value = stored && stored['bb.uiLang']; return value || 'zh';
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
  // 「控制提示」关闭时不显示任何接管浮层/呼吸边框；状态仍然保留，
  // 重新打开后 syncControlHintsVisible 会把浮层补回来。
  const settings = await readSettings().catch(() => null);
  if (settings && settings.controlHint === false) {
    await removeTakeoverDom(tabId);
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
      args: [{
        sessionId: info.sessionId || '',
        project: info.project || '',
        paused: info.paused === true,
        borrowed: info.borrowed === true,
        // 控制标签：agent 名称 / 项目 / 会话 id / 颜色都要传给页面浮层，
        // 漏传会让浮层永远显示默认的 "BridgeDeck"。
        controller: info.controller && typeof info.controller === 'object' ? info.controller : null,
        mode: info.mode || null,
        minimized: info.minimized === true,
      }, lang, (takeoverVersions.get(tabId) || 0) + 1, OVERLAY_THEME, overlayTexts(lang)],
    });
    // 可选输入锁：只在接管浮层可见且未暂停/未收起时锁页面；用户点暂停或
    // 收起后立即放开。设置默认关闭，避免无提示地改变现有交互。
    const guard = settings && settings.cooperationGuard === true &&
      info.paused !== true && info.minimized !== true;
    await setCooperationBlocked(tabId, guard, controlGeneration(tabId));
  } catch (error) {
    log('接管浮层注入失败 tab=' + tabId + '：' + ((error && error.message) || error));
  }
}

/** 只移除页面上的浮层 DOM，保留 tab 的接管状态（供重新打开控制提示时恢复）。 */
export async function removeTakeoverDom(tabId) {
  takeoverVersions.set(tabId, (takeoverVersions.get(tabId) || 0) + 1);
  await setCooperationBlocked(tabId, false, controlGeneration(tabId));
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: () => { window.__bbTakeoverVersion = (Number(window.__bbTakeoverVersion) || 0) + 1; const n = document.querySelector('[data-bb-ui="takeover"]') || document.getElementById('__bb_takeover_host'); if (n) n.remove(); } });
  } catch {
    // 页面可能已关闭
  }
}

export async function hideTakeover(tabId, options = {}) {
  closeOverlay(tabId, 'takeover');
  if (options.preserveState !== true) clearTakeoverState(tabId);
  await removeTakeoverDom(tabId);
}

/**
 * 「控制提示」开关：关闭时撤掉所有页面上的浮层，打开时按保留的状态补回。
 * 语义是“状态提示 + 呼吸边框”整块的显隐。
 * 注意 service worker 重启后内存里的 takeoverStates 会丢，所以这里同时参考
 * 持久化的 agent 窗口登记（bb.agentWindowIds）。
 */
export async function syncControlHintsVisible(visible) {
  if (!visible) {
    // 关闭：所有 http(s) 页都顺手清一遍（没有浮层的页面无副作用）
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id && /^https?:/i.test(tab.url || '')) await removeTakeoverDom(tab.id);
    }
    return;
  }
  const ids = new Set(takeoverStates.keys());
  try {
    const stored = await chrome.storage.session.get('bb.agentWindowIds');
    const windows = new Set(stored && Array.isArray(stored['bb.agentWindowIds']) ? stored['bb.agentWindowIds'] : []);
    if (windows.size) {
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) if (tab.id && windows.has(tab.windowId)) ids.add(tab.id);
    }
  } catch {
    // 读不到登记就只恢复内存里记录的
  }
  for (const tabId of ids) await showTakeover(tabId, {});
}
