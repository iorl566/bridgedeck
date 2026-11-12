// src/fetch-probe.js —— 诊断：启用 CDP Fetch 后统计 requestPaused 事件
import { acquire, onEvent, release, send as cdpSend } from './debugger.js';
import { bridgeError } from './errors.js';
import { sleep } from './tabs.js';
import { log } from './log.js';

export async function fetchProbe(params = {}) {
  const tabId = Number(params.tabId);
  if (!Number.isInteger(tabId)) throw bridgeError('E_BAD_ARG', 'fetch_probe 需要 tabId');
  const windowMs = Math.min(Math.max(Number(params.ms) || 1500, 200), 10000);
  const dbg = await acquire(tabId, 'fetch-probe');
  let paused = 0;
  const urls = [];
  const unsubscribe = onEvent(dbg, 'Fetch.requestPaused', (event) => {
    paused += 1;
    if (urls.length < 20 && event && event.request && event.request.url) urls.push(event.request.url);
    cdpSend(tabId, 'Fetch.continueRequest', { requestId: event.requestId }).catch(() => {});
  });
  let enableError = null;
  try {
    await cdpSend(tabId, 'Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    await sleep(windowMs);
  } catch (error) {
    enableError = String((error && error.message) || error);
  } finally {
    try { unsubscribe(); } catch { /* 忽略 */ }
    await cdpSend(tabId, 'Fetch.disable').catch(() => {});
    await release(tabId, 'fetch-probe').catch(() => {});
  }
  log('fetch_probe tab=' + tabId + ' paused=' + paused + (enableError ? ' error=' + enableError : ''));
  return { ok: true, paused, urls, windowMs, error: enableError };
}
