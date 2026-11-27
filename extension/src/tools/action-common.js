// src/tools/action-common.js —— 目标重试/输入焦点/焦点坐标。
import { bridgeError } from '../errors.js';
import { evalInMain, execPage } from '../inject.js';
import { sleep } from '../tabs.js';
import { isTabArmed } from '../debugger.js';
import { focusRequested } from '../lib/focus-policy.js';

const TARGET_RETRY_CODES = new Set(['E_NOT_FOUND', 'E_STALE_REF']);

export async function retryTarget(params, run) {
  const waitMs = Number(params && params.waitTimeoutMs);
  if (!(waitMs > 0) || !(params && params.selector)) return run();
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      return await run();
    } catch (error) {
      if (!error || !TARGET_RETRY_CODES.has(error.code) || Date.now() >= deadline) throw error;
      await sleep(Math.min(50, Math.max(0, deadline - Date.now())));
    }
  }
}


/**
 * 可信输入前置：默认**不切 tab、不聚焦窗口**。
 * 会话标签页已开 Emulation.setFocusEmulationEnabled，页面自认可见/聚焦，CDP 原生输入可直接派发；
 * 未挂 CDP 的标签页（借用/预挂失败）临时开焦点仿真 + 激活生命周期，仍不碰窗口焦点。
 * 只有显式 focus（CLI --focus）才回退到“真正置前”的旧路径。
 */
export async function ensureInputFocus(tabId, options = {}) {
  if (isTabArmed(tabId)) return true;
  if (focusRequested(options)) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab) {
          if (tab.active === false) await chrome.tabs.update(tabId, { active: true });
          if (Number.isInteger(tab.windowId)) {
            try {
              const win = await chrome.windows.get(tab.windowId);
              if (win && win.state === 'minimized') await chrome.windows.update(tab.windowId, { state: 'normal' });
            } catch { /* 窗口状态读取失败时仍尝试聚焦 */ }
            await chrome.windows.update(tab.windowId, { focused: true });
          }
        }
      } catch {
        // 标签/窗口已关闭或权限受限：继续尝试派发，失败会回退到页面内动作
      }
      try {
        const state = await evalInMain(tabId, 'document.visibilityState');
        if (state && state.value === 'visible') return true;
      } catch {
        // 注入失败时按不可见处理，继续重试
      }
      await sleep(120);
    }
    return false;
  }
  // 后台路径：临时焦点仿真 + active 生命周期，不激活 tab / 窗口。
  try {
    await cdpSend(tabId, 'Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
    await cdpSend(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    await waitForPaint(tabId).catch(() => sleep(32));
    return true;
  } catch {
    return false;
  }
}


export async function trustedFocusPoint(tabId, params) {
  const target = params && params.ref
    ? { ref: params.ref }
    : (params && params.selector ? { selector: params.selector } : (params && params.text ? { text: params.text } : null));
  if (!target) return null;
  return execPage(tabId, 'point', target).catch(() => null);
}

/** 同一条 CDP 会话上的命令按发送顺序执行；无需逐条等待响应，可省往返。 */


