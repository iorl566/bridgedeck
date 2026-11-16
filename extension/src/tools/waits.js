// src/tools/waits.js —— wait-ms / wait-for-element / wait-for-navigation。
import { bridgeError } from '../errors.js';
import { execPage } from '../inject.js';
import { getTab, sleep, waitForNavigation } from '../tabs.js';
import { isCommandCancelled } from '../command-cancel.js';
import {
  boundedTimeout,
  DEFAULT_ELEMENT_TIMEOUT_MS,
  DEFAULT_WAIT_NAV_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  requireTabId,
  VALID_ELEMENT_STATES,
  WAIT_ELEMENT_POLL_MS,
} from './shared.js';

/** 进行中的 wait-for-element，可被 operation cancel 中止。 */
const activeWaits = new Map();

export function cancelWait(operationId) {
  const entry = activeWaits.get(String(operationId));
  if (!entry) return { ok: false, error: '未知等待操作：' + operationId };
  entry.cancelled = true;
  return { ok: true, operationId: String(operationId) };
}

/** wait-ms */
export async function waitMs(params = {}) {
  requireTabId(params);
  const ms = Number(params.ms);
  if (!Number.isFinite(ms) || ms < 0) throw bridgeError('E_BAD_ARG', 'wait-ms 需要非负 ms');
  if (ms > MAX_TIMEOUT_MS) throw bridgeError('E_BAD_ARG', `wait-ms 上限 ${MAX_TIMEOUT_MS}ms`);
  const commandId = typeof params.commandId === 'string' ? params.commandId : '';
  const deadline = Date.now() + Math.round(ms);
  while (Date.now() < deadline) {
    if (commandId && isCommandCancelled(commandId)) throw bridgeError('E_CANCELLED', 'wait-ms 已被取消');
    await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
  }
  if (commandId && isCommandCancelled(commandId)) throw bridgeError('E_CANCELLED', 'wait-ms 已被取消');
  return { ok: true };
}

function elementStateReady(probe, state) {
  const present = Boolean(probe && probe.present);
  const visible = Boolean(probe && probe.visible);
  switch (state) {
    case 'visible':
      return present && visible;
    case 'hidden':
      return !present || !visible;
    case 'attached':
      return present;
    case 'detached':
      return !present;
    default:
      return false;
  }
}

/** wait-for-element：超时返回 satisfied:false（不抛错），与协议约定一致。 */
export async function waitForElement(params = {}) {
  const tabId = requireTabId(params);
  const selector = typeof params.selector === 'string' ? params.selector : '';
  const ref = typeof params.ref === 'string' ? params.ref : '';
  if (!selector && !ref) throw bridgeError('E_BAD_ARG', 'wait-for-element 需要 selector 或 ref');
  const stateName = typeof params.state === 'string' ? params.state : 'visible';
  if (!VALID_ELEMENT_STATES.has(stateName)) {
    throw bridgeError('E_BAD_ARG', 'state 只能是 ' + [...VALID_ELEMENT_STATES].join('/'));
  }
  const operationId = typeof params.operationId === 'string' && params.operationId
    ? params.operationId
    : 'wait-' + (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));
  const timeoutMs = boundedTimeout(params.timeoutMs, DEFAULT_ELEMENT_TIMEOUT_MS);
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const entry = { cancelled: false };
  activeWaits.set(operationId, entry);
  let probe = null;

  try {
    for (;;) {
      if (entry.cancelled) {
        return {
          satisfied: false,
          cancelled: true,
          operationId,
          state: stateName,
          selector: selector || null,
          ref: ref || null,
          attached: Boolean(probe && probe.present),
          visible: Boolean(probe && probe.visible),
          elapsedMs: Date.now() - startedAt,
        };
      }
      probe = await execPage(tabId, 'probe-state', { selector, ref, state: stateName });
      if (elementStateReady(probe, stateName)) {
        return {
          satisfied: true,
          operationId,
          state: stateName,
          selector: selector || null,
          ref: ref || null,
          attached: Boolean(probe && probe.present),
          visible: Boolean(probe && probe.visible),
          elapsedMs: Date.now() - startedAt,
        };
      }
      if (Date.now() >= deadline) {
        return {
          satisfied: false,
          operationId,
          state: stateName,
          selector: selector || null,
          ref: ref || null,
          attached: Boolean(probe && probe.present),
          visible: Boolean(probe && probe.visible),
          elapsedMs: Date.now() - startedAt,
          timedOut: true,
        };
      }
      await sleep(WAIT_ELEMENT_POLL_MS);
    }
  } finally {
    activeWaits.delete(operationId);
  }
}

/** wait-for-navigation */
export async function waitForNavigationCmd(params = {}) {
  const tabId = requireTabId(params);
  await getTab(tabId);
  const timeoutMs = boundedTimeout(params.timeoutMs, DEFAULT_WAIT_NAV_TIMEOUT_MS);
  const waitUntil = ['load', 'domcontentloaded', 'networkidle', 'commit'].includes(params.waitUntil) ? params.waitUntil : 'load';
  const navigation = await waitForNavigation(tabId, timeoutMs);
  if (waitUntil === 'commit') return { ok: true, url: navigation.url, phase: 'commit' };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const tab = await getTab(tabId);
      if (tab && tab.status === 'complete') break;
    } catch { break; }
    await sleep(50);
  }
  if (waitUntil === 'networkidle') await sleep(700);
  // 宽限：页面刚 complete 时可能紧接着开始新的主导航（重定向/SPA 跳转），
  // 只有在一段安静窗口内 URL 与状态都稳定，才算真正到达。60ms 覆盖常见重定向，
  // 需要更保守时传 graceMs。
  const graceMs = Math.max(0, Math.min(Number(params.graceMs) || 60, 2000));
  let stableSince = 0;
  let lastUrl = '';
  while (Date.now() < deadline) {
    const tab = await getTab(tabId).catch(() => null);
    const loading = !tab || tab.status === 'loading';
    const url = (tab && tab.url) || '';
    if (!loading && url === lastUrl) {
      if (!stableSince) stableSince = Date.now();
      if (Date.now() - stableSince >= graceMs) break;
    } else {
      stableSince = 0;
    }
    lastUrl = url;
    await sleep(30);
  }
  const settled = await getTab(tabId).catch(() => null);
  return { ok: true, url: (settled && settled.url) || navigation.url, phase: waitUntil };
}
