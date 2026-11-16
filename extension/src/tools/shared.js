// src/tools/shared.js —— 页面工具共享的超时/参数原语。
import { bridgeError } from '../errors.js';

export const DEFAULT_NAV_TIMEOUT_MS = 30000;
export const DEFAULT_ELEMENT_TIMEOUT_MS = 10000;
export const DEFAULT_WAIT_NAV_TIMEOUT_MS = 30000;
export const MAX_TIMEOUT_MS = 120000;
export const WAIT_ELEMENT_POLL_MS = 150;
export const VALID_ELEMENT_STATES = new Set(['visible', 'hidden', 'attached', 'detached']);

export function requireTabId(params) {
  if (!params || !Number.isInteger(params.tabId)) {
    throw bridgeError('E_BAD_ARG', '缺少 tabId（由 daemon 注入）');
  }
  return params.tabId;
}

export function boundedTimeout(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.max(Math.round(number), 100), MAX_TIMEOUT_MS);
}
