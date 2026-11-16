// src/tools/read.js —— read / extract / evaluate / console。
import { bridgeError } from '../errors.js';
import { execPage, evalByCdp, evalInMain, readConsole } from '../inject.js';
import { isAttached } from '../debugger.js';
import { readDocumentIdentity, sameDocumentIdentity } from '../document-identity.js';
import { shadowRefRead } from './shadow.js';
import { shadowRefs } from './state.js';
import { pageAction } from './page-action.js';
import { requireTabId } from './shared.js';
const rawRead = pageAction('read');
/** 读类操作的文档身份护栏：读取前后主文档必须一致，否则这次采样不可信。 */
async function withDocumentIdentity(tabId, fn) {
  const before = await readDocumentIdentity(tabId).catch(() => null);
  const result = await fn();
  if (before) {
    const after = await readDocumentIdentity(tabId).catch(() => null);
    if (!sameDocumentIdentity(before, after)) {
      throw bridgeError('E_CONTEXT_STALE', '读取期间主文档发生变化（导航或重渲染），本次 read/extract 结果已丢弃；请重新 observe');
    }
  }
  return result;
}

export async function read(params = {}) {
  const tabId = requireTabId(params);
  if (params && params.ref) {
    const map = shadowRefs.get(tabId);
    const entry = map && map.get(params.ref);
    if (entry) {
      const text = await shadowRefRead(tabId, entry).catch(() => null);
      if (text != null) return { value: text, text, via: 'closed-shadow-ref' };
    }
  }
  return withDocumentIdentity(tabId, () => rawRead(params));
}
export const extract = pageAction('extract');
/** extract：discover 候选表格/列表，或按 target id / selector 导出。 */
export async function extractDiscover(params = {}) {
  const tabId = requireTabId(params);
  return withDocumentIdentity(tabId, () => execPage(tabId, 'extract', { discover: true }));
}

export async function extractList(params = {}) {
  const tabId = requireTabId(params);
  return withDocumentIdentity(tabId, () => execPage(tabId, 'extract', {
    mode: 'list',
    target: params.target,
    selector: params.selector,
    ref: params.ref,
    itemSelector: params.itemSelector,
    fields: params.fields,
    maxRows: params.maxRows,
    maxBytes: params.maxBytes,
  }));
}

export async function extractTable(params = {}) {
  const tabId = requireTabId(params);
  return withDocumentIdentity(tabId, () => execPage(tabId, 'extract', {
    target: params.target,
    selector: params.selector,
    ref: params.ref,
    maxRows: params.maxRows,
    maxBytes: params.maxBytes,
  }));
}

/** evaluate（主世界）；--unverified 跳过观察校验，结果标记 verified:false。 */
export async function evaluate(params = {}) {
  const tabId = requireTabId(params);
  if (typeof params.expression !== 'string' || !params.expression.trim()) {
    throw bridgeError('E_BAD_ARG', 'evaluate 需要非空 expression');
  }
  // 会话标签页已挂 CDP：Runtime.evaluate 快路径（也天然绕过页面 CSP）。
  // 未挂载（借用 tab / 预挂失败）时退回注入式 eval，语义一致。
  let result = null;
  if (isAttached(tabId)) {
    result = await evalByCdp(tabId, params.expression).catch(() => null);
  }
  if (!result) result = await evalInMain(tabId, params.expression);
  return params.unverified === true ? { ...result, verified: false } : result;
}

/** console */
export async function consoleEntries(params = {}) {
  const tabId = requireTabId(params);
  const since = Number(params.since);
  const limit = Number(params.limit);
  return readConsole(tabId, Number.isFinite(since) ? since : undefined, Number.isInteger(limit) && limit > 0 ? limit : undefined);
}

