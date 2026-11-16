// src/tools/navigation.js —— navigate / reload / back / forward。
import { bridgeError } from '../errors.js';
import { execPage } from '../inject.js';
import { getTab, sleep, waitForLoad } from '../tabs.js';
import { clearObservationCache } from './observation.js';
import { log } from '../log.js';
import { showTakeover } from '../takeover.js';
import { clearFrameAliases } from './frames.js';
import { recentFillFocus, shadowRefs } from './state.js';
import { boundedTimeout, DEFAULT_NAV_TIMEOUT_MS, requireTabId } from './shared.js';

async function resetRefsQuietly(tabId) {
  try {
    await execPage(tabId, 'reset-refs', {});
  } catch (error) {
    log(`清理 tab ${tabId} 的 ref 表失败（忽略）`, error && error.message);
  }
}

/** navigate */
export async function navigate(params = {}) {
  const tabId = requireTabId(params);
  if (typeof params.url !== 'string' || !params.url.trim()) {
    throw bridgeError('E_BAD_ARG', 'navigate 需要非空 url');
  }
  const url = params.url.trim();
  const tab = await getTab(tabId);
  shadowRefs.delete(tabId);
  clearFrameAliases(tabId);
  recentFillFocus.delete(tabId);
  const timeoutMs = boundedTimeout(params.timeoutMs, DEFAULT_NAV_TIMEOUT_MS);
  try {
    if ((tab.url || '') === url) {
      await chrome.tabs.reload(tabId);
    } else {
      await chrome.tabs.update(tabId, { url });
    }
  } catch (error) {
    throw bridgeError('E_NAV_FAIL', `导航到 ${url} 失败: ${(error && error.message) || error}`);
  }
  const loaded = await waitForLoad(tabId, timeoutMs);
  if (!loaded) log(`tab ${tabId} 导航 ${timeoutMs}ms 内未完成加载，返回当前状态`);
  await resetRefsQuietly(tabId);
  clearObservationCache(tabId);
  const current = await getTab(tabId);
  // 浮层是可见性提示，注入失败/延迟不影响导航结果；不阻塞导航返回。
  showTakeover(tabId, { name: 'BridgeDeck' }).catch(() => {});
  return { url: current.url || current.pendingUrl || url, title: current.title || '' };
}

/** reload */
export async function reload(params = {}) {
  const tabId = requireTabId(params);
  await getTab(tabId);
  try {
    await chrome.tabs.reload(tabId);
  } catch (error) {
    throw bridgeError('E_NAV_FAIL', `reload 失败: ${(error && error.message) || error}`);
  }
  await waitForLoad(tabId, 15000).catch(() => null);
  await resetRefsQuietly(tabId);
  clearObservationCache(tabId);
  return { ok: true };
}

async function waitForHistorySettled(tabId, beforeUrl, timeoutMs = 15000) {
  // bfcache 恢复不会触发 load 事件；只等 waitForLoad 会白等到超时。
  // 这里以"status=complete 且 URL 已变、没有在途导航"为准，正常加载与 bfcache 都能立即满足。
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = await getTab(tabId).catch(() => null);
    if (!tab) break;
    if (tab.pendingUrl || tab.status === 'loading') {
      await sleep(50);
      continue;
    }
    if (tab.status === 'complete' && tab.url && (tab.url !== beforeUrl || beforeUrl === '')) return true;
    await sleep(50);
  }
  return false;
}

async function goHistory(tabId, direction) {
  const before = await getTab(tabId);
  const beforeUrl = (before && before.url) || '';
  try {
    if (direction === 'back') await chrome.tabs.goBack(tabId);
    else await chrome.tabs.goForward(tabId);
  } catch (error) {
    throw bridgeError('E_NAV_FAIL', `历史${direction === 'back' ? '后退' : '前进'}失败: ${(error && error.message) || error}`);
  }
  await waitForHistorySettled(tabId, beforeUrl, 15000);
  await resetRefsQuietly(tabId);
  clearObservationCache(tabId);
  return { ok: true };
}

export async function goBack(params = {}) {
  return goHistory(requireTabId(params), 'back');
}

export async function goForward(params = {}) {
  return goHistory(requireTabId(params), 'forward');
}
