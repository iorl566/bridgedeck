// src/tools/read.js —— read / extract / evaluate / console。
import { bridgeError } from '../errors.js';
import { execPage, execPageAllFrames, evalByCdp, evalInMain, readConsole } from '../inject.js';
import { isAttached } from '../debugger.js';
import { readDocumentIdentity, sameDocumentIdentity } from '../document-identity.js';
import { shadowRefRead } from './shadow.js';
import { shadowRefs } from './state.js';
import { pageAction } from './page-action.js';
import { requireTabId } from './shared.js';
import { EXTRACT_LIMITS, mergeDiscoverFrames, selectFrameIds } from '../lib/extract-limits.js';
import { decodeExtractCursor, encodeExtractCursor, verifyExtractCursor } from '../lib/extract-cursor.js';
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
/** extract.cursor：多页续取的无状态游标（offset + revision + target）。 */
const rawExtract = pageAction('extract');
function decodeCursorParams(params, kind) {
  if (!params || params.cursor === undefined) return { params, cursor: null };
  const decoded = decodeExtractCursor(String(params.cursor));
  if (!decoded.ok) throw bridgeError('E_CURSOR_STALE', 'extract cursor 无效或已过期：' + decoded.reason);
  const cursor = decoded.cursor;
  const mismatch = verifyExtractCursor(cursor, { tabId: params.tabId, frameId: params.frameId, kind });
  if (mismatch) throw bridgeError('E_CURSOR_STALE', 'extract cursor 不可用：' + mismatch);
  const merged = { ...params };
  if (!merged.selector && !merged.ref && (merged.target === undefined || merged.target === null || merged.target === '')) {
    const target = cursor.target || {};
    if (target.target !== undefined && target.target !== null && target.target !== '') merged.target = target.target;
    if (target.selector) merged.selector = target.selector;
    if (target.ref) merged.ref = target.ref;
    if (target.mode) merged.mode = target.mode;
    if (target.itemSelector) merged.itemSelector = target.itemSelector;
    if (Array.isArray(target.fields)) merged.fields = target.fields;
  }
  if (!Number.isInteger(merged.frameId) && Number.isInteger(cursor.frameId)) merged.frameId = cursor.frameId;
  merged.offset = cursor.offset;
  return { params: merged, cursor };
}
function finishExtract(result, params, cursor) {
  if (cursor) {
    const mismatch = verifyExtractCursor(cursor, { kind: result && result.kind, revision: result && result.revision });
    if (mismatch) throw bridgeError('E_CURSOR_STALE', 'extract cursor 不可用：' + mismatch);
  }
  if (!result || result.hasMore !== true) return result;
  const offset = Number(result.offset) || 0;
  const returned = Array.isArray(result.rows) ? result.rows.length : 0;
  if (returned <= 0) return result;
  result.cursor = encodeExtractCursor({
    tabId: params.tabId,
    frameId: Number.isInteger(params.frameId) ? params.frameId : 0,
    kind: result.kind,
    offset: offset + returned,
    revision: result.revision,
    target: {
      target: params.target,
      selector: params.selector,
      ref: params.ref,
      mode: params.mode,
      itemSelector: params.itemSelector,
      fields: params.fields,
    },
  });
  return result;
}
export async function extract(params = {}) {
  // compat extract action：tool.extract 用 action=table|list|discover 选择导出方式。
  if (params && params.action) {
    const action = String(params.action);
    const next = { ...params };
    delete next.action;
    if (action === 'table') return extractTable(next);
    if (action === 'list') return extractList(next);
    if (action === 'discover') return extractDiscover(next);
    throw bridgeError('E_BAD_ARG', 'extract action 只能是 table/list/discover');
  }
  const prepared = decodeCursorParams(params, null);
  const result = await rawExtract(prepared.params);
  return finishExtract(result, prepared.params, prepared.cursor);
}
/** extract：discover 候选表格/列表（16 帧 / 32 target / 8 预览列上限），或按 target id / selector 导出。 */
export async function extractDiscover(params = {}) {
  const tabId = requireTabId(params);
  const maxTargets = Number.isInteger(params.maxTargets) ? params.maxTargets : EXTRACT_LIMITS.targets;
  const previewColumns = Number.isInteger(params.previewColumns) ? params.previewColumns : EXTRACT_LIMITS.previewColumns;
  const discoverArgs = { discover: true, maxTargets, previewColumns };
  let frameIds = null;
  let framesSeen = 0;
  try {
    const all = await chrome.webNavigation.getAllFrames({ tabId });
    if (Array.isArray(all) && all.length) {
      const picked = selectFrameIds(all.map((frame) => frame.frameId), EXTRACT_LIMITS.frames);
      frameIds = picked.frameIds;
      framesSeen = picked.framesSeen;
    }
  } catch { frameIds = null; }
  const frames = await execPageAllFrames(tabId, 'extract', discoverArgs, frameIds ? { frameIds } : {}).catch(() => null);
  if (Array.isArray(frames)) {
    return mergeDiscoverFrames(frames, {
      maxFrames: EXTRACT_LIMITS.frames,
      maxTargets,
      previewColumns,
      framesSeen: framesSeen || frames.length,
    });
  }
  const single = await withDocumentIdentity(tabId, () => execPage(tabId, 'extract', discoverArgs));
  return {
    targets: (Array.isArray(single.targets) ? single.targets : []).slice(0, maxTargets).map((target) => ({ ...target, frameId: 0 })),
    frameCount: 1,
    framesScanned: 1,
    framesSeen: 1,
    truncated: single.truncated === true,
    limits: { maxFrames: EXTRACT_LIMITS.frames, maxTargets, previewColumns },
  };
}

export async function extractList(params = {}) {
  const prepared = decodeCursorParams(params, 'list');
  const tabId = requireTabId(prepared.params);
  const p = prepared.params;
  const frameId = Number.isInteger(p.frameId) ? p.frameId : 0;
  return withDocumentIdentity(tabId, async () => finishExtract(await execPage(tabId, 'extract', {
    mode: 'list',
    target: p.target,
    selector: p.selector,
    ref: p.ref,
    itemSelector: p.itemSelector,
    fields: p.fields,
    maxRows: p.maxRows,
    maxBytes: p.maxBytes,
    maxCells: p.maxCells,
    offset: p.offset,
  }, frameId), p, prepared.cursor));
}

export async function extractTable(params = {}) {
  const prepared = decodeCursorParams(params, 'table');
  const tabId = requireTabId(prepared.params);
  const p = prepared.params;
  const frameId = Number.isInteger(p.frameId) ? p.frameId : 0;
  return withDocumentIdentity(tabId, async () => finishExtract(await execPage(tabId, 'extract', {
    target: p.target,
    selector: p.selector,
    ref: p.ref,
    maxRows: p.maxRows,
    maxBytes: p.maxBytes,
    maxCells: p.maxCells,
    offset: p.offset,
  }, frameId), p, prepared.cursor));
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

