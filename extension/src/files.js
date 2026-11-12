// src/files.js —— 下载：点元素或导航后，等待该 tab 发起的下载完成（chrome.downloads）
import { bridgeError, mapChromeError } from './errors.js';
import { execPage } from './inject.js';
import { getTab, sleep } from './tabs.js';
import { acquire, release, send as cdpSend } from './debugger.js';
import { log } from './log.js';

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 120000;
const POLL_MS = 200;

function boundedTimeout(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.round(number), 1000), MAX_TIMEOUT_MS);
}

function normalizeItem(item) {
  return {
    downloadId: item.id,
    filename: item.filename || '',
    bytes: Number(item.fileSize) > 0 ? Number(item.fileSize) : Number(item.totalBytes) || 0,
    state: item.state,
    url: item.url || '',
    mime: item.mime || '',
  };
}

/**
 * download：先用 ref/selector 点击或导航到 url，再等该 tab 发起的下载结束。
 * 下载目录由浏览器决定；CLI 需要落盘时自己复制。
 */
export async function download(params = {}) {
  const tabId = params.tabId;
  if (!Number.isInteger(tabId)) throw bridgeError('E_BAD_ARG', 'download 需要 tabId');
  await getTab(tabId);
  const hasTarget = Boolean(params.ref || params.selector);
  const hasUrl = typeof params.url === 'string' && params.url.trim().length > 0;
  if (!hasTarget && !hasUrl) throw bridgeError('E_BAD_ARG', 'download 需要 ref/selector 或 url');
  if (hasTarget && hasUrl) throw bridgeError('E_BAD_ARG', 'download 的 ref/selector 与 url 只能给一个');

  const timeoutMs = boundedTimeout(params.timeoutMs);
  // 先记录已有下载，避免把"之前就在的下载"误当成这次的结果；
  // 有些浏览器把 initiator tab 记成 -1，因此 tabId 只作优先，不作为硬条件。
  let baseline = new Set();
  try {
    const existing = await chrome.downloads.search({ limit: 50 });
    baseline = new Set((existing || []).map((item) => item.id));
  } catch {
    baseline = new Set();
  }
  const started = [];
  const onCreated = (item) => {
    if (!item || baseline.has(item.id)) return;
    started.push(item.id);
    log('观测到下载 id=' + item.id + ' tab=' + item.tabId + ' url=' + (item.url || ''));
  };
  chrome.downloads.onCreated.addListener(onCreated);
  try {
    if (hasTarget) {
      // 下载必须由"可信"用户手势触发，否则 Chrome 会静默拦截自动下载。
      // 优先用 CDP Input 在该元素上真实点一下，失败再退回脚本 click。
      let clickedViaCdp = false;
      try {
        await acquire(tabId, 'download');
        const rect = await execPage(tabId, 'element-rect', { ref: params.ref, selector: params.selector });
        const x = Math.round(rect.x + rect.width / 2);
        const y = Math.round(rect.y + rect.height / 2);
        await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
        clickedViaCdp = true;
      } catch (error) {
        log('CDP 点击失败，退回脚本点击：' + ((error && error.message) || error));
      } finally {
        await release(tabId, 'download').catch(() => {});
      }
      if (!clickedViaCdp) {
        await execPage(tabId, 'click', { ref: params.ref, selector: params.selector });
      }
    } else {
      try {
        await chrome.tabs.update(tabId, { url: String(params.url).trim() });
      } catch (error) {
        throw mapChromeError(error, '导航到下载地址失败');
      }
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      if (!started.length) continue;
      const id = started[started.length - 1];
      let items = [];
      try {
        items = await chrome.downloads.search({ id });
      } catch (error) {
        throw mapChromeError(error, '查询下载状态失败');
      }
      const item = items && items[0];
      if (!item) continue;
      if (item.state === 'complete') return normalizeItem(item);
      if (item.state === 'interrupted') {
        const reason = item.error || 'interrupted';
        throw bridgeError('E_DOWNLOAD_FAILED', '下载中断：' + reason);
      }
    }
    throw bridgeError('E_NO_DOWNLOAD', '等待 ' + timeoutMs + 'ms 没有观测到完成下载');
  } finally {
    chrome.downloads.onCreated.removeListener(onCreated);
  }
}
