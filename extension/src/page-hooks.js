// src/page-hooks.js —— 按需注入的页面主世界钩子（console 缓冲 + 请求命令归因）。
//
// 背景：这些钩子以前由 manifest 的 content_scripts 在 document_start 静态注入
// 到所有页面，等于给用户浏览的每一个站点都打上"console/fetch/XHR 被改写"的
// 指纹。像素扫描（tamperedFunctions）、BrowserScan（CDP Robot）、
// fingerprint-scan（CDP Stack Check）、rebrowser（runtimeEnableLeak）都会命中。
//
// 现在改为：只有真正需要读取页面 console 的调用（console 采集、调试采集）才
// 注入；注入状态按标签页记录，并在导航/关页时失效，命令结束可主动还原。
import { log } from './log.js';

const TRANSPORT_FILE = 'injected/main-console.js';
const RESTORE_FILE = 'injected/main-console-restore.js';

/** tabId -> 注入时的时间戳（仅用于诊断；导航会清掉） */
const installed = new Map();

function normalize(tabId) {
  const id = Number(tabId);
  return Number.isInteger(id) ? id : null;
}

export function hasHooks(tabId) {
  const id = normalize(tabId);
  return id != null && installed.has(id);
}

export function listHookedTabs() {
  return [...installed.keys()];
}

/** 失效标记：导航后主世界脚本已随文档重建，钩子不再存在。 */
export function forgetHooks(tabId) {
  const id = normalize(tabId);
  if (id != null) installed.delete(id);
}

/** 注入主世界钩子；重复调用安全（脚本自身幂等）。返回是否处于生效状态。 */
export async function ensureHooks(tabId) {
  const id = normalize(tabId);
  if (id == null) return false;
  if (installed.has(id)) return true;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: id },
      world: 'MAIN',
      files: [TRANSPORT_FILE],
    });
    installed.set(id, Date.now());
    return true;
  } catch (error) {
    // 受限页面（chrome://、错误页）注入失败：保持无钩子状态，调用方自行降级。
    log('页面钩子注入失败 tab=' + id + '：' + ((error && error.message) || error));
    return false;
  }
}

/** 还原主世界补丁；失败不抛（页面可能已关闭）。 */
export async function releaseHooks(tabId) {
  const id = normalize(tabId);
  if (id == null) return false;
  installed.delete(id);
  try {
    await chrome.scripting.executeScript({
      target: { tabId: id },
      world: 'MAIN',
      files: [RESTORE_FILE],
    });
    return true;
  } catch {
    return false;
  }
}

function installInvalidation() {
  try {
    if (chrome.webNavigation && chrome.webNavigation.onCommitted) {
      chrome.webNavigation.onCommitted.addListener((details) => {
        if (details && details.frameId === 0) forgetHooks(details.tabId);
      });
    }
  } catch {
    // 测试环境没有 webNavigation
  }
  try {
    if (chrome.tabs && chrome.tabs.onRemoved) {
      chrome.tabs.onRemoved.addListener((tabId) => forgetHooks(tabId));
    }
  } catch {
    // 同上
  }
}

installInvalidation();
