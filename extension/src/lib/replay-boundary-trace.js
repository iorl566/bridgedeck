// extension/src/lib/replay-boundary-trace.js —— 边界轨迹模型（第二轮，从 replay-boundary-exec.js 拆出）。
//
// 纯轨迹层：归一化真实身份轨迹（documentId/frameId/URL/revision/loaderId/tabId）、
// 身份序列与变化点、身份摘要、轨迹内身份匹配、以及边界执行 providers 的归一化。
// 零时钟/随机；被 replay-boundary-judge.js 与 replay-boundary-exec.js 单向依赖。

import { stableHash } from '../record-steps.js';
import { compareBoundary, normalizeBoundary, normalizeDocumentId, normalizeFrameId, normalizeUrlKey } from './replay-boundary.js';

export const REPLAY_BOUNDARY_EXEC_VERSION = 2;

/** 边界执行结果码（机器可读；解释层负责映射到失败目录）。 */
export const BOUNDARY_EXEC_CODES = Object.freeze({
  OK: 'BOUNDARY_EXEC_OK',
  MATCHED: 'BOUNDARY_EXEC_MATCHED',
  NEEDS_ACTION: 'BOUNDARY_EXEC_NEEDS_ACTION',
  BLOCKED: 'BOUNDARY_EXEC_BLOCKED',
  PLAN_MISSING: 'BOUNDARY_EXEC_PLAN_MISSING',
  TRACE_EMPTY: 'BOUNDARY_EXEC_TRACE_EMPTY',
  TRACE_INVALID: 'BOUNDARY_EXEC_TRACE_INVALID',
  TRACE_TRUNCATED: 'BOUNDARY_EXEC_TRACE_TRUNCATED',
  URL_MISSING: 'BOUNDARY_EXEC_URL_MISSING',
  FRAME_MISSING: 'BOUNDARY_EXEC_FRAME_MISSING',
  TAB_MISSING: 'BOUNDARY_EXEC_TAB_MISSING',
  CURRENT_UNKNOWN: 'BOUNDARY_EXEC_CURRENT_UNKNOWN',
  PROVIDER_MISSING: 'BOUNDARY_EXEC_PROVIDER_MISSING',
  NAVIGATE_OK: 'BOUNDARY_EXEC_NAVIGATE_OK',
  NAVIGATE_URL_MISMATCH: 'BOUNDARY_EXEC_NAVIGATE_URL_MISMATCH',
  NAVIGATE_NOT_CONFIRMED: 'BOUNDARY_EXEC_NAVIGATE_NOT_CONFIRMED',
  FRAME_OK: 'BOUNDARY_EXEC_FRAME_OK',
  FRAME_URL_MISMATCH: 'BOUNDARY_EXEC_FRAME_URL_MISMATCH',
  FRAME_NOT_CONFIRMED: 'BOUNDARY_EXEC_FRAME_NOT_CONFIRMED',
  TAB_OK: 'BOUNDARY_EXEC_TAB_OK',
  TAB_NOT_CONFIRMED: 'BOUNDARY_EXEC_TAB_NOT_CONFIRMED',
  RESUME_OK: 'BOUNDARY_EXEC_RESUME_OK',
  RESUME_NO_MATCH: 'BOUNDARY_EXEC_RESUME_NO_MATCH',
  STALE_DOCUMENT: 'BOUNDARY_EXEC_STALE_DOCUMENT',
  ORDER: 'BOUNDARY_EXEC_ORDER',
});

/** 轨迹/执行上限。 */
export const BOUNDARY_EXEC_LIMITS = Object.freeze({
  maxEntries: 2000,
  maxEvidence: 24,
  maxText: 300,
  maxUrl: 2048,
  maxDocumentId: 180,
});

/** 轨迹条目种类：身份采样 / 导航 / 帧切换 / tab 切换 / 恢复 / 观测。 */
export const BOUNDARY_TRACE_KINDS = Object.freeze([
  'identity',
  'navigation',
  'frame-switch',
  'tab-switch',
  'resume',
  'observation',
]);

const TRACE_KIND_SET = new Set(BOUNDARY_TRACE_KINDS);

// ---------------------------------------------------------------------------
// 基础工具（与 executor 同风格：零时钟、有界）
// ---------------------------------------------------------------------------

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonNegativeInt(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.floor(number);
}

function clampInt(value, min, max) {
  return Math.min(max, Math.max(min, nonNegativeInt(value, min)));
}

function shortText(value, max = BOUNDARY_EXEC_LIMITS.maxText) {
  const text = value === null || value === undefined ? '' : String(value);
  return text.length > max ? text.slice(0, max) : text;
}

function uniqueStrings(values, limit = BOUNDARY_EXEC_LIMITS.maxEvidence) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const text = shortText(value, 400);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 轨迹归一
// ---------------------------------------------------------------------------

/** 归一化轨迹条目种类：未知值按 identity（最保守的身份采样）。 */
function normalizeTraceKind(value) {
  const text = String(value || '').trim().toLowerCase();
  if (TRACE_KIND_SET.has(text)) return text;
  if (text === 'navigate' || text === 'page') return 'navigation';
  if (text === 'frame' || text === 'iframe') return 'frame-switch';
  if (text === 'tab') return 'tab-switch';
  if (text === 'observe') return 'observation';
  return 'identity';
}

/**
 * 归一化一条真实身份轨迹条目。
 * 接受：{kind, atMs|at|timestamp, documentId, frameId, url, revision, loaderId, tabId, status}
 * 也接受 step 形状（evidence/boundary/branch 里的身份字段）。
 * @param {unknown} input
 * @param {number} sourceIndex
 * @returns {object|null} 全空条目返回 null（由调用方记为 invalid）
 */
export function normalizeTraceEntry(input, sourceIndex = 0) {
  if (!isObject(input)) return null;
  const identity = normalizeBoundary(input);
  const hasIdentity = Boolean(
    identity.documentId
    || identity.urlKey
    || identity.loaderId
    || (input.frameId !== undefined && input.frameId !== null)
    || (input.tabId !== undefined && input.tabId !== null)
    || input.kind !== undefined,
  );
  if (!hasIdentity) return null;
  const atCandidate = input.atMs !== undefined ? input.atMs : (input.at !== undefined ? input.at : input.timestamp);
  const atMs = Number.isFinite(Number(atCandidate)) && Number(atCandidate) >= 0 ? Math.floor(Number(atCandidate)) : null;
  const status = Number.isFinite(Number(input.status)) ? Number(input.status) : null;
  return {
    index: 0,
    sourceIndex: nonNegativeInt(sourceIndex),
    kind: normalizeTraceKind(input.kind || input.type),
    atMs,
    identity,
    documentId: identity.documentId,
    documentKind: identity.documentKind,
    frameId: identity.frameId,
    url: identity.url,
    urlKey: identity.urlKey,
    urlOrigin: identity.urlOrigin,
    revision: identity.revision,
    loaderId: identity.loaderId,
    navigationId: identity.navigationId,
    tabId: identity.tabId,
    status,
    label: shortText(input.label || input.source, 80),
  };
}

/** 轨迹摘要（有界、稳定）。 */
export function summarizeBoundaryTrace(traceResult) {
  const trace = isObject(traceResult) && Array.isArray(traceResult.entries)
    ? traceResult
    : normalizeBoundaryTrace(traceResult || []);
  const entries = trace.entries;
  const kinds = {};
  for (const entry of entries) kinds[entry.kind] = (kinds[entry.kind] || 0) + 1;
  const last = entries.length ? entries[entries.length - 1] : null;
  return {
    version: REPLAY_BOUNDARY_EXEC_VERSION,
    entries: entries.length,
    documents: new Set(entries.map((entry) => entry.documentId).filter(Boolean)).size,
    frames: new Set(entries.map((entry) => entry.frameId)).size,
    urls: new Set(entries.map((entry) => entry.urlKey).filter(Boolean)).size,
    kinds,
    timed: entries.length > 1 && entries.every((entry) => entry.atMs !== null),
    firstAtMs: entries.length && entries[0].atMs !== null ? entries[0].atMs : null,
    lastAtMs: last && last.atMs !== null ? last.atMs : null,
    lastIdentity: last ? summarizeIdentity(last.identity) : null,
    issues: Array.isArray(trace.issues) ? trace.issues.length : 0,
    digest: String(trace.digest || ''),
  };
}

/**
 * 归一化整条轨迹：排序（有时间戳时按时间稳定排序）、去重相邻相同项、结构自检。
 * @param {Array<object>|{entries:Array<object>}} traceInput
 * @param {{maxEntries?:number}} [options]
 * @returns {object}
 */
export function normalizeBoundaryTrace(traceInput, options = {}) {
  const raw = Array.isArray(traceInput)
    ? traceInput
    : (isObject(traceInput) && Array.isArray(traceInput.entries) ? traceInput.entries : []);
  const maxEntries = options.maxEntries === undefined
    ? BOUNDARY_EXEC_LIMITS.maxEntries
    : clampInt(options.maxEntries, 1, BOUNDARY_EXEC_LIMITS.maxEntries);
  const entries = [];
  const issues = [];
  for (let index = 0; index < raw.length && entries.length < maxEntries; index += 1) {
    const entry = normalizeTraceEntry(raw[index], index);
    if (!entry) {
      issues.push({ code: BOUNDARY_EXEC_CODES.TRACE_INVALID, index, message: '轨迹条目没有任何身份字段' });
      continue;
    }
    entries.push(entry);
  }
  if (raw.length > maxEntries) {
    issues.push({ code: BOUNDARY_EXEC_CODES.TRACE_TRUNCATED, maxEntries, total: raw.length, message: '轨迹条目超过上限，已截断' });
  }
  const allTimed = entries.length > 1 && entries.every((entry) => entry.atMs !== null);
  let reordered = false;
  if (allTimed) {
    const order = entries.map((entry, position) => ({ entry, position }));
    order.sort((left, right) => left.entry.atMs - right.entry.atMs || left.position - right.position);
    if (order.some((item, position) => item.position !== position)) reordered = true;
    entries.length = 0;
    for (const item of order) entries.push(item.entry);
  }
  entries.forEach((entry, index) => { entry.index = index; });

  // 结构自检：documentId 在不相邻位置复用 / revision 回退 / 导航条目缺 URL。
  const documentEpochs = new Map();
  let previousRevision = null;
  for (const entry of entries) {
    if (entry.documentId) {
      const previous = documentEpochs.get(entry.documentId);
      if (previous !== undefined && previous !== entries[entry.index - 1]?.documentId) {
        issues.push({
          code: BOUNDARY_EXEC_CODES.ORDER,
          index: entry.index,
          documentId: shortText(entry.documentId, 40),
          message: '同一 documentId 在不相邻的轨迹位置复用（可能丢事件或真实重渲染）',
        });
      }
      documentEpochs.set(entry.documentId, entry.index);
    }
    if (entry.revision !== null && previousRevision !== null && entry.revision < previousRevision) {
      issues.push({
        code: BOUNDARY_EXEC_CODES.STALE_DOCUMENT,
        index: entry.index,
        previous: previousRevision,
        next: entry.revision,
        message: '轨迹 revision 回退，顺序疑似异常',
      });
    }
    if (entry.revision !== null) previousRevision = entry.revision;
    if (entry.kind === 'navigation' && !entry.urlKey) {
      issues.push({ code: BOUNDARY_EXEC_CODES.URL_MISSING, index: entry.index, message: '导航轨迹条目没有 URL' });
    }
  }
  if (reordered) {
    issues.push({ code: BOUNDARY_EXEC_CODES.TRACE_INVALID, index: -1, message: '轨迹时间戳乱序，已按时间稳定重排' });
  }
  const digest = traceDigestOf(entries);
  return {
    version: REPLAY_BOUNDARY_EXEC_VERSION,
    entries,
    issues,
    reordered,
    digest,
    summary: summarizeBoundaryTrace({ entries, issues, digest }),
  };
}

/** 轨迹指纹：只包含身份轨迹（doc/frame/tab/url/revision），不含标签/时间值。 */
export function traceDigestOf(entries) {
  const list = Array.isArray(entries) ? entries : [];
  return stableHash(list.map((entry) => [
    String(entry && entry.kind || ''),
    String(entry && entry.documentId || ''),
    'f' + normalizeFrameId(entry && entry.frameId),
    entry && entry.urlKey ? normalizeUrlKey(entry.urlKey).key : '',
    entry && entry.revision === null ? '-' : String(entry && entry.revision),
    entry && entry.tabId === null ? '' : 't' + String(entry && entry.tabId),
  ].join('|')).join('>'));
}

/** 轨迹 → 身份序列（points + transitions），用于“真实 documentId/URL 轨迹判定”。 */
export function traceIdentitySeries(traceInput) {
  const trace = isObject(traceInput) && Array.isArray(traceInput.entries)
    ? traceInput
    : normalizeBoundaryTrace(traceInput);
  const entries = trace.entries;
  const points = entries.map((entry) => ({
    index: entry.index,
    atMs: entry.atMs,
    kind: entry.kind,
    documentId: entry.documentId,
    documentKind: entry.documentKind,
    frameId: entry.frameId,
    tabId: entry.tabId,
    urlKey: entry.urlKey,
    revision: entry.revision,
  }));
  const transitions = [];
  for (let index = 1; index < entries.length; index += 1) {
    const before = entries[index - 1];
    const after = entries[index];
    const comparison = compareBoundary(before.identity, after.identity, { mode: 'frame' });
    const kind = comparison.documentChanged === true
      ? 'document'
      : comparison.tabChanged === true
        ? 'tab'
        : comparison.frameChanged
          ? 'frame'
          : comparison.urlChanged === true
            ? 'url'
            : comparison.revisionChanged === true
              ? 'revision'
              : '';
    if (!kind) continue;
    transitions.push({
      index: after.index,
      fromIndex: before.index,
      kind,
      relation: comparison.relation,
      before: summarizeIdentity(before.identity),
      after: summarizeIdentity(after.identity),
      evidence: {
        documentChanged: comparison.documentChanged === true,
        frameChanged: comparison.frameChanged === true,
        tabChanged: comparison.tabChanged === true,
        urlChanged: comparison.urlChanged === true,
        revisionChanged: comparison.revisionChanged === true,
      },
    });
  }
  const last = entries.length ? entries[entries.length - 1].identity : null;
  return {
    version: REPLAY_BOUNDARY_EXEC_VERSION,
    points,
    transitions,
    changed: transitions.length,
    lastIdentity: last ? summarizeIdentity(last) : null,
    digest: stableHash(points.map((point) => [point.index, point.documentId || '', 'f' + point.frameId, point.urlKey || ''].join('|')).join('>')),
  };
}

/** 身份的紧凑证据（保留可判定的 documentId 前缀/形态与 URL 键，避免整段正文进输出）。 */
export function summarizeIdentity(identityInput) {
  const identity = normalizeBoundary(identityInput);
  return {
    documentId: shortText(normalizeDocumentId(identity.documentId), 48),
    documentKind: identity.documentKind,
    frameId: identity.frameId,
    revision: identity.revision,
    urlKey: shortText(identity.urlKey, 300),
    urlOrigin: identity.urlOrigin,
    loaderId: shortText(identity.loaderId, 48),
    tabId: identity.tabId,
  };
}

/**
 * 在轨迹里找与期望身份匹配的位置。
 * 默认 mode='frame'（文档 + 帧），因为 revision/URL 是 epoch 内的软变化。
 * @returns {{found:boolean, index:number, entry:object|null, comparison:object|null,
 *   relation:string, nearest:object|null}}
 */
export function matchTraceIdentity(traceInput, expectedInput, options = {}) {
  const trace = isObject(traceInput) && Array.isArray(traceInput.entries)
    ? traceInput
    : normalizeBoundaryTrace(traceInput);
  const expected = normalizeBoundary(expectedInput);
  const mode = options.mode || 'frame';
  let nearest = null;
  for (const entry of trace.entries) {
    const comparison = compareBoundary(expected, entry.identity, { mode });
    if (comparison.ok) {
      if (options.requireUrl === true && expected.urlKey && entry.urlKey) {
        if (expected.urlKey !== entry.urlKey) continue;
      }
      return {
        found: true,
        index: entry.index,
        entry,
        comparison,
        relation: comparison.relation,
        nearest: nearest || null,
      };
    }
    const score = comparison.documentChanged === false ? 2 : 1;
    if (!nearest || score > nearest.score) {
      nearest = { score, index: entry.index, entry, comparison, relation: comparison.relation };
    }
  }
  return {
    found: false,
    index: -1,
    entry: null,
    comparison: nearest ? nearest.comparison : null,
    relation: nearest ? nearest.relation : 'no-match',
    nearest,
  };
}

export function normalizeBoundaryProviders(providers = {}) {
  const source = isObject(providers) ? providers : {};
  const fn = (value) => (typeof value === 'function' ? value : null);
  return {
    navigate: fn(source.navigate),
    switchFrame: fn(source.switchFrame),
    switchTab: fn(source.switchTab),
    sampleIdentity: fn(source.sampleIdentity),
    resumeAt: fn(source.resumeAt),
  };
}

// 轨迹层内部工具：供 judge / exec 复用。
export { isObject, nonNegativeInt, clampInt, shortText, uniqueStrings };
