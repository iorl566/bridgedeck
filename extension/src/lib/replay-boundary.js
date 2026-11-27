// extension/src/lib/replay-boundary.js —— 录制→回放的边界还原单源（纯函数，零 chrome 依赖）。
//
// 录制侧（record-steps.js / record-events.js）给每条 step 挂了
//   evidence: { seq, frameId, documentId, revision, url, actor, at }
// 以及 event.boundary: { documentId, frameId, revision }。回放时这些身份几乎必然变化：
// SPA 重渲染会换 documentId、导航会换 frame 与 document、DOM 代数（revision）会推进。
// 本模块负责“单点判定 + 帧树 + 同窗口分段”：
//   1) 录制的 step 还能不能“在同一个窗口里”重放（compareBoundary / canReplayInWindow）；
//   2) 帧树关系（framePathOf / frameRelation）与批量同窗口区间（replayWindowSegments）。
// 换窗口时的整体还原规划（epoch 切分、navigate/frame-switch/abort）在
// replay-boundary-plan.js —— 本文件被它 import，保持单向依赖。
// 全程不猜：拿不到可证明的信息就给原因，绝不“换个选择器硬跑”。
//
// 设计约束：
//   - 纯函数：同输入同输出，不读时钟、不用随机数、不访问 chrome/node 全局；
//   - 复用 record-steps 的 stableHash，指纹与录制侧/计划侧保持一致；
//   - 判定与根 lib/replay-timeline.mjs 兼容：同样只用 documentId/frameId/revision
//     三个字段做“同窗口”判定，reason 字符串保持 'document-changed' /
//     'frame-changed' / 'revision-changed' / 'same-window'，便于既有调用方迁移；
//   - 本模块只“判定 + 规划”，不改任何既有字段，也不执行副作用。

import { stableHash } from '../record-steps.js';

/** 边界模型版本：plan/token 里带版本，规则变化时能显式不兼容。 */
export const REPLAY_BOUNDARY_VERSION = 1;

/** 两个边界的相对关系（compareBoundary().relation 的取值）。 */
export const BOUNDARY_RELATIONS = Object.freeze({
  SAME: 'same',
  DOCUMENT_CHANGED: 'document-changed',
  FRAME_CHANGED: 'frame-changed',
  REVISION_CHANGED: 'revision-changed',
  URL_CHANGED: 'url-changed',
  MISSING: 'missing-boundary',
});

/** 判定严格度：
 *  - exact    文档/帧/revision/url 都必须一致（回放中最严，默认）；
 *  - document 只要文档一致即可（同一文档内允许帧/代数/路由变化）；
 *  - frame    文档 + 帧一致（帧内允许代数/路由变化）；
 *  - loose    只拒绝“可证明的换文档”，证据不足时放行（用于诊断/预览）。
 */
export const BOUNDARY_MODES = Object.freeze(['exact', 'document', 'frame', 'loose']);

const MODE_SET = new Set(BOUNDARY_MODES);

/** documentId 的来源优先级：CDP loaderId > chrome.documentId > 录制证据 > 合成值。 */
export const DOCUMENT_ID_SOURCES = Object.freeze(['cdp-loader-id', 'chrome-document-id', 'recorded', 'synthetic']);

/** documentId 形态分类（只用于解释与去重，不参与相等判定）。 */
export const DOCUMENT_ID_KINDS = Object.freeze({
  MISSING: 'missing',
  UUID: 'uuid',
  LOADER: 'loader-id',
  SYNTHETIC: 'synthetic',
  OPAQUE: 'opaque',
});

/** 边界相关的阻断/警告码（与 replay-plan / replay-explain 对齐）。 */
export const BOUNDARY_CODES = Object.freeze({
  URL_MISSING: 'BOUNDARY_URL_MISSING',
  FRAME_UNAVAILABLE: 'BOUNDARY_FRAME_UNAVAILABLE',
  TAB_MISSING: 'BOUNDARY_TAB_MISSING',
  DOCUMENT_CONFLICT: 'BOUNDARY_DOCUMENT_CONFLICT',
  CURRENT_UNKNOWN: 'BOUNDARY_CURRENT_UNKNOWN',
  REVISION_REGRESSION: 'BOUNDARY_REVISION_REGRESSION',
  NAVIGATION_REQUIRED: 'BOUNDARY_NAVIGATION_REQUIRED',
  REPLAY_WINDOW_MATCHED: 'BOUNDARY_REPLAY_WINDOW_MATCHED',
});

/** 硬上限：证据字段一律截断，避免恶意/异常录制把内存撑爆。 */
export const BOUNDARY_LIMITS = Object.freeze({
  maxDocumentId: 180,
  maxUrl: 2048,
  maxNavigationId: 180,
  maxFrameId: 2147483647,
  maxSteps: 4000,
});

/** 边界关系对应的严重度：hard 换窗口、soft 需重新绑定、none 同窗口。 */
const RELATION_SEVERITY = Object.freeze({
  [BOUNDARY_RELATIONS.SAME]: 'none',
  [BOUNDARY_RELATIONS.DOCUMENT_CHANGED]: 'hard',
  [BOUNDARY_RELATIONS.FRAME_CHANGED]: 'hard',
  [BOUNDARY_RELATIONS.REVISION_CHANGED]: 'soft',
  [BOUNDARY_RELATIONS.URL_CHANGED]: 'soft',
  [BOUNDARY_RELATIONS.MISSING]: 'unknown',
});

const HARD_RELATIONS = new Set([BOUNDARY_RELATIONS.DOCUMENT_CHANGED, BOUNDARY_RELATIONS.FRAME_CHANGED, BOUNDARY_RELATIONS.MISSING]);

// ---------------------------------------------------------------------------
// 基础归一化
// ---------------------------------------------------------------------------

/** 把任意值收敛成有长度上限的字符串（不抛异常）。 */
export function normalizeText(value, max = 200) {
  if (value == null) return '';
  const text = typeof value === 'string' ? value : String(value);
  const trimmed = text.trim();
  const limit = Number.isFinite(Number(max)) && Number(max) > 0 ? Math.floor(Number(max)) : 200;
  return trimmed.length > limit ? trimmed.slice(0, limit) : trimmed;
}

/** 归一化 documentId：null/undefined/非字符串 → ''；其余截断。 */
export function normalizeDocumentId(value) {
  return normalizeText(value, BOUNDARY_LIMITS.maxDocumentId);
}

/**
 * 判断 documentId 的形态（用于解释“为什么对不上”，不参与相等判定）。
 * @param {unknown} value
 * @returns {'missing'|'uuid'|'loader-id'|'synthetic'|'opaque'}
 */
export function documentIdKind(value) {
  const id = normalizeDocumentId(value);
  if (!id) return DOCUMENT_ID_KINDS.MISSING;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return DOCUMENT_ID_KINDS.UUID;
  if (/^[0-9A-F]{16,64}$/.test(id)) return DOCUMENT_ID_KINDS.LOADER;
  if (/^(?:synthetic|doc|frame):/i.test(id)) return DOCUMENT_ID_KINDS.SYNTHETIC;
  return DOCUMENT_ID_KINDS.OPAQUE;
}

/**
 * 从多个来源里挑 documentId，按 DOCUMENT_ID_SOURCES 的优先级。
 * 候选可以是字符串，也可以是 { id, source } 对象；同优先级取先出现的。
 * @param {Array<string|{id?:unknown, source?:string}>} candidates
 * @returns {{id:string, source:string, rank:number, kind:string}}
 */
export function pickDocumentId(candidates) {
  const list = Array.isArray(candidates) ? candidates : (candidates == null ? [] : [candidates]);
  let best = { id: '', source: '', rank: -1, kind: DOCUMENT_ID_KINDS.MISSING };
  for (const candidate of list) {
    const id = normalizeDocumentId(candidate && typeof candidate === 'object' ? candidate.id : candidate);
    if (!id) continue;
    const rawSource = candidate && typeof candidate === 'object' ? normalizeText(candidate.source, 40) : '';
    const rank = DOCUMENT_ID_SOURCES.indexOf(rawSource);
    const effectiveRank = rank >= 0 ? rank : DOCUMENT_ID_SOURCES.length;
    if (best.rank === -1 || effectiveRank < best.rank) {
      best = {
        id,
        source: rank >= 0 ? rawSource : 'unknown',
        rank: effectiveRank,
        kind: documentIdKind(id),
      };
    }
  }
  return best;
}

/** 归一化 frameId：合法非负整数原样；其它（含 null）→ 0（主帧）。 */
export function normalizeFrameId(value) {
  if (value === null || value === undefined || value === '') return 0;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > BOUNDARY_LIMITS.maxFrameId) return 0;
  return number;
}

/** 归一化 revision：合法非负整数 → 数字；否则 null（“未知”，不当作 0）。 */
export function normalizeRevision(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) return null;
  return number;
}

/**
 * 归一化 URL 键：去掉 hash（同文档内的锚点不换文档），保留 origin+path+search。
 * 解析失败时退回截断后的原文，保证“至少能比较”。
 * @param {unknown} url
 * @returns {{url:string, origin:string, path:string, key:string, valid:boolean}}
 */
export function normalizeUrlKey(url) {
  const raw = normalizeText(url, BOUNDARY_LIMITS.maxUrl);
  if (!raw) return { url: '', origin: '', path: '', key: '', valid: false };
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      // 非 http(s)（about:/data:/mailto:）不当作可导航 URL，退回原文比较。
      return { url: raw, origin: '', path: raw, key: raw, valid: false };
    }
    const origin = parsed.origin;
    const path = parsed.pathname || '/';
    return {
      url: raw,
      origin,
      path: path + parsed.search,
      key: origin + path + parsed.search,
      valid: true,
    };
  } catch {
    return { url: raw, origin: '', path: raw, key: raw, valid: false };
  }
}

/** 从 step/evidence/boundary 里读取 tabId（只在明确给了整数时采用）。 */
function normalizeTabId(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) return null;
  return number;
}

/**
 * 归一化一个边界。入参可以是：
 *   - 任意对象（直接读 documentId/frameId/revision/url/tabId 等）；
 *   - step（会读 step.evidence、step.boundary、step.branch）；
 *   - 已是归一化边界（幂等）。
 * 字段优先级：入参顶层 > evidence > boundary。
 * @param {unknown} input
 * @returns {{version:number, documentId:string, documentKind:string, frameId:number,
 *   revision:number|null, url:string, urlKey:string, urlOrigin:string,
 *   navigationId:string, loaderId:string, tabId:number|null}}
 */
export function normalizeBoundary(input) {
  const source = input && typeof input === 'object' ? input : {};
  const evidence = source.evidence && typeof source.evidence === 'object' ? source.evidence : {};
  const boundary = source.boundary && typeof source.boundary === 'object' ? source.boundary : {};
  const branch = source.branch && typeof source.branch === 'object' ? source.branch : {};
  const read = (field) => {
    if (source[field] !== undefined && source[field] !== null && source[field] !== '') return source[field];
    if (evidence[field] !== undefined && evidence[field] !== null && evidence[field] !== '') return evidence[field];
    if (boundary[field] !== undefined && boundary[field] !== null && boundary[field] !== '') return boundary[field];
    return undefined;
  };
  const documentId = normalizeDocumentId(read('documentId'));
  const urlInput = read('url');
  const urlInfo = normalizeUrlKey(urlInput);
  const tabId = normalizeTabId(read('tabId') !== undefined ? read('tabId') : branch.tabId);
  return {
    version: REPLAY_BOUNDARY_VERSION,
    documentId,
    documentKind: documentIdKind(documentId),
    frameId: normalizeFrameId(read('frameId')),
    revision: normalizeRevision(read('revision')),
    url: urlInfo.url,
    urlKey: urlInfo.key,
    urlOrigin: urlInfo.origin,
    navigationId: normalizeText(read('navigationId'), BOUNDARY_LIMITS.maxNavigationId),
    loaderId: normalizeText(read('loaderId'), BOUNDARY_LIMITS.maxNavigationId),
    tabId,
  };
}

/** 从 step（录制 step v2）提取边界：evidence 为主，branch 里的 tab/window 切换也带上。 */
export function boundaryFromStep(step) {
  if (!step || typeof step !== 'object') return normalizeBoundary(null);
  return normalizeBoundary(step);
}

/** 从 evidence 对象提取边界（record-steps 的 evidence 形状）。 */
export function boundaryFromEvidence(evidence) {
  return normalizeBoundary(evidence && typeof evidence === 'object' ? evidence : null);
}

/** 复制边界并替换 revision（用于“同一文档推进代数”的模拟/比较）。 */
export function withRevision(boundaryInput, revision) {
  const boundary = normalizeBoundary(boundaryInput);
  return { ...boundary, revision: normalizeRevision(revision) };
}

/** 复制边界并替换 frameId/url（用于帧切换后的预期边界）。 */
export function withFrame(boundaryInput, frameId, url) {
  const boundary = normalizeBoundary(boundaryInput);
  const urlInfo = normalizeUrlKey(url === undefined ? boundary.url : url);
  return {
    ...boundary,
    frameId: normalizeFrameId(frameId),
    url: urlInfo.url,
    urlKey: urlInfo.key,
    urlOrigin: urlInfo.origin,
  };
}

/** 边界的规范键（用于 Map/去重/指纹）。revision 未知写作 '-'。 */
export function boundaryKey(boundaryInput) {
  const boundary = normalizeBoundary(boundaryInput);
  return [
    boundary.documentId || '-',
    'f' + boundary.frameId,
    'r' + (boundary.revision === null ? '-' : boundary.revision),
    boundary.tabId === null ? '' : 't' + boundary.tabId,
  ].join('|');
}

/** 边界的稳定短哈希（8 位十六进制，与 record-steps.stableHash 同源）。 */
export function boundaryHash(boundaryInput) {
  return stableHash(boundaryKey(boundaryInput));
}

// ---------------------------------------------------------------------------
// 单点比较
// ---------------------------------------------------------------------------

/** 只比文档：两个都缺 → null（未知）；否则相等布尔。 */
export function sameDocument(leftInput, rightInput) {
  const left = normalizeBoundary(leftInput);
  const right = normalizeBoundary(rightInput);
  if (!left.documentId || !right.documentId) return null;
  return left.documentId === right.documentId;
}

/** 只比帧：frameId 缺省按主帧 0 处理（与根 replay-timeline 一致）。 */
export function sameFrame(leftInput, rightInput) {
  const left = normalizeBoundary(leftInput);
  const right = normalizeBoundary(rightInput);
  return left.frameId === right.frameId;
}

/** 只比 revision：任一侧未知 → null。 */
export function sameRevision(leftInput, rightInput) {
  const left = normalizeBoundary(leftInput);
  const right = normalizeBoundary(rightInput);
  if (left.revision === null || right.revision === null) return null;
  return left.revision === right.revision;
}

/** 只比 URL 键（去 hash）：任一侧没有 URL → null。 */
export function sameUrl(leftInput, rightInput) {
  const left = normalizeBoundary(leftInput);
  const right = normalizeBoundary(rightInput);
  if (!left.urlKey || !right.urlKey) return null;
  return left.urlKey === right.urlKey;
}

/** 只比 tab：任一侧未知 → null。 */
export function sameTab(leftInput, rightInput) {
  const left = normalizeBoundary(leftInput);
  const right = normalizeBoundary(rightInput);
  if (left.tabId === null || right.tabId === null) return null;
  return left.tabId === right.tabId;
}

/** 关系是否属于“换窗口”（文档/帧/证据缺失），这类变化不能靠重选元素绕过。 */
export function isHardChange(relation) {
  return HARD_RELATIONS.has(String(relation || ''));
}

/** 关系 → 严重度（'none'|'soft'|'hard'|'unknown'）。 */
export function boundarySeverity(relation) {
  return RELATION_SEVERITY[String(relation || '')] || 'unknown';
}

/**
 * 比较两个边界，给出关系 + 逐字段证据 + 是否满足指定严格度。
 * @param {unknown} beforeInput 录制时的边界（或 step/event）。
 * @param {unknown} afterInput 当前/回放时的边界。
 * @param {{mode?:'exact'|'document'|'frame'|'loose'}} [options]
 * @returns {{
 *   ok:boolean, relation:string, reason:string, mode:string, severity:string,
 *   checks:{document:object, frame:object, revision:object, url:object, tab:object},
 *   reasons:Array<object>, documentChanged:boolean|null, frameChanged:boolean,
 *   revisionChanged:boolean|null, urlChanged:boolean|null, tabChanged:boolean|null,
 *   detail:string
 * }}
 */
export function compareBoundary(beforeInput, afterInput, options = {}) {
  const mode = MODE_SET.has(options && options.mode) ? options.mode : 'exact';
  const before = normalizeBoundary(beforeInput);
  const after = normalizeBoundary(afterInput);
  const reasons = [];
  const push = (code, field, expected, actual, severity) => {
    reasons.push({ code, field, expected, actual, severity: severity || 'error' });
  };

  const docSame = before.documentId && after.documentId ? before.documentId === after.documentId : null;
  const docKnown = docSame !== null;
  const frameChanged = before.frameId !== after.frameId;
  const revSame = before.revision !== null && after.revision !== null ? before.revision === after.revision : null;
  const urlSame = before.urlKey && after.urlKey ? before.urlKey === after.urlKey : null;
  const tabSame = before.tabId !== null && after.tabId !== null ? before.tabId === after.tabId : null;

  if (docKnown && docSame === false) {
    push(BOUNDARY_RELATIONS.DOCUMENT_CHANGED, 'documentId', before.documentId, after.documentId, 'error');
  } else if (!docKnown) {
    push(BOUNDARY_RELATIONS.MISSING, 'documentId', before.documentId, after.documentId, 'warning');
  }
  if (frameChanged) push(BOUNDARY_RELATIONS.FRAME_CHANGED, 'frameId', before.frameId, after.frameId, 'error');
  if (revSame === false) push(BOUNDARY_RELATIONS.REVISION_CHANGED, 'revision', before.revision, after.revision, 'warning');
  if (urlSame === false) push(BOUNDARY_RELATIONS.URL_CHANGED, 'url', before.urlKey, after.urlKey, 'info');
  if (tabSame === false) push('tab-changed', 'tabId', before.tabId, after.tabId, 'error');

  let relation = BOUNDARY_RELATIONS.SAME;
  if (!docKnown) relation = BOUNDARY_RELATIONS.MISSING;
  else if (docSame === false) relation = BOUNDARY_RELATIONS.DOCUMENT_CHANGED;
  else if (frameChanged) relation = BOUNDARY_RELATIONS.FRAME_CHANGED;
  else if (revSame === false) relation = BOUNDARY_RELATIONS.REVISION_CHANGED;
  else if (urlSame === false) relation = BOUNDARY_RELATIONS.URL_CHANGED;
  // tab 变化比文档更“外层”：两者都变时报 tab-changed，计划侧仍需导航+换 tab。
  if (tabSame === false) relation = 'tab-changed';

  const checks = {
    document: { same: docSame, known: docKnown, before: before.documentId, after: after.documentId },
    frame: { same: !frameChanged, before: before.frameId, after: after.frameId },
    revision: { same: revSame, known: revSame !== null, before: before.revision, after: after.revision },
    url: { same: urlSame, known: urlSame !== null, before: before.urlKey, after: after.urlKey },
    tab: { same: tabSame, known: tabSame !== null, before: before.tabId, after: after.tabId },
  };

  let ok;
  if (mode === 'exact') ok = relation === BOUNDARY_RELATIONS.SAME;
  else if (mode === 'frame') ok = docKnown && docSame === true && !frameChanged;
  else if (mode === 'document') ok = docKnown && docSame === true;
  else ok = docSame !== false; // loose：只拒绝可证明的换文档

  return {
    ok,
    relation,
    reason: relation,
    mode,
    severity: boundarySeverity(relation),
    checks,
    reasons,
    documentChanged: docSame === null ? null : docSame === false,
    frameChanged,
    revisionChanged: revSame === null ? null : revSame === false,
    urlChanged: urlSame === null ? null : urlSame === false,
    tabChanged: tabSame === null ? null : tabSame === false,
    detail: boundaryDetail(relation, before, after),
  };
}

/** 关系 → 中文一句话解释（失败可解释用；不拼敏感值，只给形态与短哈希）。 */
function boundaryDetail(relation, before, after) {
  switch (relation) {
    case BOUNDARY_RELATIONS.SAME:
      return '文档/帧/代数与录制时一致，可在同一窗口重放';
    case BOUNDARY_RELATIONS.DOCUMENT_CHANGED:
      return 'documentId 已变化（录制 ' + shortId(before.documentId) + ' → 当前 ' + shortId(after.documentId) + '），需先导航到录制 URL';
    case BOUNDARY_RELATIONS.FRAME_CHANGED:
      return 'frameId 已变化（录制 f' + before.frameId + ' → 当前 f' + after.frameId + '），需先切回录制帧';
    case BOUNDARY_RELATIONS.REVISION_CHANGED:
      return 'DOM 代数已推进（r' + String(before.revision) + ' → r' + String(after.revision) + '），元素引用需重新绑定';
    case BOUNDARY_RELATIONS.URL_CHANGED:
      return '路由已变化（' + shortUrl(before.urlKey) + ' → ' + shortUrl(after.urlKey) + '），元素引用需重新绑定';
    case BOUNDARY_RELATIONS.MISSING:
      return '缺少 documentId（至少一侧），无法证明同文档；按严格度决定是否继续';
    case 'tab-changed':
      return 'tabId 已变化（' + String(before.tabId) + ' → ' + String(after.tabId) + '），需先切回录制页';
    default:
      return '边界关系未知';
  }
}

function shortId(id) {
  const text = String(id || '');
  if (!text) return '空';
  return text.length > 12 ? text.slice(0, 8) + '…' : text;
}

function shortUrl(key) {
  const text = String(key || '');
  if (!text) return '空';
  return text.length > 48 ? text.slice(0, 45) + '…' : text;
}

/**
 * 兼容根 lib/replay-timeline.mjs 的 canReplay：event 可以是 {boundary} 或 step/evidence。
 * reason 保持 'same-window' / 'document-changed' / 'frame-changed' /
 * 'revision-changed' / 'missing-boundary'，调用方可零改动迁移。
 * @param {unknown} recorded
 * @param {unknown} current
 * @param {object} [options]
 */
export function canReplayInWindow(recorded, current, options = {}) {
  const comparison = compareBoundary(recorded, current, options);
  const reason = comparison.relation === BOUNDARY_RELATIONS.SAME ? 'same-window' : comparison.relation;
  return { ok: comparison.ok, reason, comparison };
}

/** 判定“回放必须换窗口”：文档或帧变了；revision/url 变化只需重新绑定。 */
export function requiresNewWindow(beforeInput, afterInput) {
  const comparison = compareBoundary(beforeInput, afterInput, { mode: 'frame' });
  return {
    required: !comparison.ok,
    comparison,
    reason: comparison.ok ? 'same-window' : comparison.relation,
  };
}

/** 边界指纹：与 revision 无关的“文档+帧”身份（用于快照索引键）。 */
export function boundaryScopeKey(boundaryInput) {
  const boundary = normalizeBoundary(boundaryInput);
  return (boundary.documentId || '-') + '|f' + boundary.frameId;
}

// ---------------------------------------------------------------------------
// frame 树
// ---------------------------------------------------------------------------

/**
 * 归一化 chrome.webNavigation.getAllFrames / CDP Page.getFrameTree 的帧列表。
 * @param {unknown} frames
 * @returns {Array<{frameId:number, parentFrameId:number, url:string}>}
 */
export function normalizeFrameList(frames) {
  const list = Array.isArray(frames) ? frames : [];
  const out = [];
  for (const frame of list) {
    if (!frame || typeof frame !== 'object') continue;
    const frameId = normalizeFrameId(frame.frameId);
    const parent = frame.parentFrameId === undefined || frame.parentFrameId === null ? -1 : Number(frame.parentFrameId);
    out.push({
      frameId,
      parentFrameId: Number.isInteger(parent) ? parent : -1,
      url: normalizeText(frame.url, BOUNDARY_LIMITS.maxUrl),
    });
  }
  // 按 frameId 稳定排序，保证同集合不同输入顺序得到同一输出。
  out.sort((left, right) => left.frameId - right.frameId);
  return out;
}

/** 找到某帧（找不到返回 null）。 */
export function findFrame(frames, frameId) {
  const id = normalizeFrameId(frameId);
  const list = normalizeFrameList(frames);
  return list.find((frame) => frame.frameId === id) || null;
}

/** 主帧（frameId 0）判定。 */
export function isMainFrame(frameId) {
  return normalizeFrameId(frameId) === 0;
}

/**
 * 从根到该帧的路径（frameId 数组）。父链断裂/死循环时返回能走到的部分并停止。
 * @returns {number[]}
 */
export function framePathOf(frames, frameId) {
  const list = normalizeFrameList(frames);
  const byId = new Map(list.map((frame) => [frame.frameId, frame]));
  const path = [];
  const seen = new Set();
  let current = normalizeFrameId(frameId);
  while (!seen.has(current)) {
    seen.add(current);
    path.unshift(current);
    const frame = byId.get(current);
    if (!frame || frame.parentFrameId < 0 || frame.parentFrameId === current) break;
    current = frame.parentFrameId;
    if (path.length > 64) break;
  }
  return path;
}

/** 帧深度（主帧 0；找不到 -1）。 */
export function frameDepth(frames, frameId) {
  const path = framePathOf(frames, frameId);
  if (!path.length) return -1;
  if (path[0] !== 0 && !findFrame(frames, 0)) return path.length - 1;
  return Math.max(0, path.length - 1);
}

/**
 * 两个帧的关系：same / descendant / ancestor / sibling / unrelated / unknown。
 * 用于解释“录制的 iframe 现在挂到了别的父帧下”这类变化。
 */
export function frameRelation(recordedFrameId, currentFrameId, frames) {
  const recorded = normalizeFrameId(recordedFrameId);
  const current = normalizeFrameId(currentFrameId);
  if (recorded === current) return 'same';
  const list = normalizeFrameList(frames);
  const byId = new Set(list.map((frame) => frame.frameId));
  if (list.length && (!byId.has(recorded) || !byId.has(current))) return 'unknown';
  const recordedPath = framePathOf(list, recorded);
  const currentPath = framePathOf(list, current);
  if (!recordedPath.length || !currentPath.length) return 'unknown';
  if (currentPath.includes(recorded)) return 'descendant';
  if (recordedPath.includes(current)) return 'ancestor';
  if (recordedPath[recordedPath.length - 2] === currentPath[currentPath.length - 2]) return 'sibling';
  return 'unrelated';
}

/** 帧 URL 是否与录制时一致（用于帧切换前的可证明校验）。 */
export function frameUrlMatches(recordedUrl, frameUrl, options = {}) {
  const left = normalizeUrlKey(recordedUrl);
  const right = normalizeUrlKey(frameUrl);
  if (!left.key || !right.key) return { ok: false, reason: 'missing-url' };
  if (left.key === right.key) return { ok: true, reason: 'exact' };
  if (options && options.allowOriginOnly && left.origin && left.origin === right.origin) {
    return { ok: true, reason: 'same-origin' };
  }
  return { ok: false, reason: 'url-changed' };
}


/** 归一化严格度：未知值一律按最严的 exact 处理（安全默认）。 */
export function normalizeBoundaryMode(mode) {
  return MODE_SET.has(mode) ? mode : 'exact';
}

export function replayWindowSegments(steps, currentInput, options = {}) {
  const list = Array.isArray(steps) ? steps : [];
  const mode = MODE_SET.has(options.mode) ? options.mode : 'exact';
  const segments = [];
  let open = null;
  let blocked = 0;
  let replayable = 0;
  for (let index = 0; index < list.length; index += 1) {
    const boundary = boundaryFromStep(list[index]);
    const comparison = currentInput ? compareBoundary(boundary, currentInput, { mode }) : null;
    const ok = comparison ? comparison.ok : true;
    if (ok) {
      replayable += 1;
      if (!open) {
        open = { startIndex: index, endIndex: index, count: 0, boundary, comparison };
        segments.push(open);
      }
      open.endIndex = index;
      open.count += 1;
    } else {
      blocked += 1;
      open = null;
    }
  }
  return {
    segments,
    blocked,
    replayable,
    total: list.length,
    mode,
    fingerprint: stableHash(segments.map((segment) => boundaryScopeKey(segment.boundary) + '@' + segment.startIndex).join('>')),
  };
}
