// src/errors.js —— 扩展侧错误码（见 PROTOCOL.md §5.3）
import { warn } from './log.js';

const KNOWN_CODES = new Set([
  'E_BAD_ARG',
  'E_NOT_FOUND',
  'E_STALE_REF',
  'E_TIMEOUT',
  'E_NAV_FAIL',
  'E_JS_ERROR',
  'E_NO_TAB',
  'E_UNKNOWN_METHOD',
  'E_INTERNAL',
  // v0.2
  'E_DEBUGGER_BUSY',
  'E_BORROW_DENIED',
  'E_BORROW_TIMEOUT',
  'E_HELP_DISABLED',
  'E_NO_DOWNLOAD',
  'E_DOWNLOAD_FAILED',
  'E_TOO_LARGE',
  'E_BAD_MODE',
  'E_CACHE_EMPTY',
  'E_CONTEXT_STALE',
  'E_CONTEXT_REQUIRED',
  'E_OBSERVATION_STALE',
  'E_EXPECT_FAILED',
  'E_DIALOG_PENDING',
  'E_EXISTS',
  'E_CURSOR_STALE',
  'E_NO_FILE_CHOOSER',
  'E_INCOGNITO_UNAVAILABLE',
  'E_DEPENDS_FAILED',
  'E_OCCLUDED',
  'E_INPUT_BUSY',
  'E_CANCELLED',
  'E_SESSION_PAUSED',
]);

/** 构造带错误码的 Error。 */
export function bridgeError(code, message, data) {
  const error = new Error(message);
  error.code = KNOWN_CODES.has(code) ? code : 'E_INTERNAL';
  if (data !== undefined) error.data = data;
  return error;
}

/** 把任意异常转成协议要求的 { code, message }。 */
export function toWireError(error) {
  if (error && typeof error.code === 'string' && error.code.startsWith('E_')) {
    const payload = { code: error.code, message: String(error.message || error.code) };
    if (error.data !== undefined) payload.data = error.data;
    return payload;
  }
  warn('未归类的扩展异常', error);
  return {
    code: 'E_INTERNAL',
    message: String((error && error.message) || error || '未知错误'),
  };
}

/** 把 chrome.* API 抛出的错误映射成协议错误码。 */
export function mapChromeError(error, fallbackMessage) {
  const message = String((error && error.message) || error || fallbackMessage || 'chrome API 调用失败');
  if (/No tab with id|Invalid tab ID|Tab .* was closed/i.test(message)) {
    return bridgeError('E_NO_TAB', message);
  }
  if (/Cannot access (contents|chrome|a chrome)|The extensions gallery|chrome:\/\//i.test(message)) {
    return bridgeError('E_INTERNAL', `无法在该页面执行脚本（受限页面）: ${message}`);
  }
  if (/Frame with ID 0 was removed|No frame with id 0|The frame was removed/i.test(message)) {
    return bridgeError('E_INTERNAL', `页面 frame 已失效（可能刚发生导航）: ${message}`);
  }
  return bridgeError('E_INTERNAL', message);
}
