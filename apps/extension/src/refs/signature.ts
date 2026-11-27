// src/refs/signature.ts —— ref 的稳定身份与失效判定（纯函数，无浏览器/无 daemon 依赖）。
//
// 与 0.3.0 JS 扩展（extension/src/refs/ref-registry.js）对齐的是**语义与签名算法**，
// 不是对象形状：
// - RefKey = backendNodeId + frameId + cdpSessionId + documentId + revision + generation；
// - 稳定性签名 = FNV-1a(documentId, frameId, backendNodeId, cdpSessionId)，不含 revision
//   （内容变化不换身份），documentId 变化一定换签名 —— 同 JS makeStabilitySignature；
// - 动作前用 assessRefMatch 比较“登记时的身份”与“调用方期望的身份”，
//   返回 E_STALE_REF 语义的结构化原因，而不是让动作层自己拼字符串。
//
// TS 栈特有的一个事实：本批不接 chrome.debugger，因此拿不到 backendNodeId（也没有
// cdpSessionId）。页面侧观察会给每个节点一个 identity（tag|id|role|name|序号）。
// 有 backendNodeId 时签名与 JS 逐字符一致；没有时在哈希里补上 identity，避免同文档
// 不同节点的签名全部退化成同一个值。

/** FNV-1a（与 JS 扩展同一实现）：只用于可比较的稳定性签名，不做安全哈希。 */
export function signatureHash(value: string): string {
  let h = 2166136261;
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    h ^= text.charCodeAt(index);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** 正整数或 null（0/负/小数/非数字都归 null）。 */
export function positiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

/** 非空字符串或 null（去空白后判定；保留原始值，不做 trim 改写）。 */
export function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** generation：非负整数或 null。 */
export function generationOf(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

/** frameId 归一：与 JS 一致（非整数一律 0；主文档为 0）。 */
function frameIdOf(value: unknown): number {
  return Number.isInteger(Number(value)) ? Number(value) : 0;
}

/** revision 归一：整数或 null。 */
function revisionOf(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

/** 登记 ref 时需要的身份片段。identity 仅在没有 backendNodeId 时参与签名。 */
export interface RefKeyParts {
  backendNodeId?: number | null;
  frameId?: number | null;
  cdpSessionId?: string | null;
  documentId?: string | null;
  revision?: number | null;
  generation?: number | null;
  /** TS 无 CDP 时的节点身份（tag|id|role|name|序号）。 */
  identity?: string | null;
}

/** 冻结后的完整 RefKey（与 JS makeRefKey/makeFenceKey 字段一致）。 */
export interface RefKey {
  readonly backendNodeId: number | null;
  readonly frameId: number;
  readonly cdpSessionId: string | null;
  readonly documentId: string;
  readonly revision: number | null;
  readonly generation: number | null;
}

/**
 * 稳定性签名（纯函数）。
 *
 * - 有 backendNodeId（或者既无 backendNodeId 也无 identity）时，输出与 JS
 *   makeStabilitySignature 逐字符一致：`sig:` + hash([documentId, frameId,
 *   backendNodeId|'-', cdpSessionId|'-'])；
 * - 只有 identity（TS 无 CDP 路径）时，第四个位置换成 `identity:<identity>`，
 *   保证同文档不同节点的签名可区分。
 *
 * @throws Error documentId 缺失时（与 JS 一致：签名必须绑定文档）。
 */
export function makeStabilitySignature(parts: RefKeyParts = {}): string {
  const documentId = nonEmpty(parts.documentId);
  if (!documentId) throw new Error('稳定性签名需要 documentId');
  const backendNodeId = positiveInteger(parts.backendNodeId);
  const frameId = frameIdOf(parts.frameId);
  const cdpSessionId = nonEmpty(parts.cdpSessionId) || '-';
  const identity = nonEmpty(parts.identity);
  const nodePart = backendNodeId !== null
    ? String(backendNodeId)
    : (identity ? 'identity:' + identity : '-');
  return 'sig:' + signatureHash([documentId, frameId, nodePart, cdpSessionId].join('\u0000'));
}

/** 两个签名是否一致（空值一律视为不一致；与 JS sameStabilitySignature 同义）。 */
export function sameStabilitySignature(a: unknown, b: unknown): boolean {
  return typeof a === 'string' && a.length > 0 && a === b;
}

/**
 * 只带文档围栏信息的 RefKey（不要求 backendNodeId）。
 * 与 JS makeFenceKey 一致：documentId 缺失抛错，其余字段归一后冻结。
 */
export function makeFenceKey(parts: RefKeyParts = {}): RefKey {
  const documentId = nonEmpty(parts.documentId);
  if (!documentId) throw new Error('RefKey 需要 documentId');
  return Object.freeze({
    backendNodeId: positiveInteger(parts.backendNodeId),
    frameId: frameIdOf(parts.frameId),
    cdpSessionId: nonEmpty(parts.cdpSessionId),
    documentId,
    revision: revisionOf(parts.revision),
    generation: generationOf(parts.generation),
  });
}

/** 完整 RefKey：既要节点身份也要文档身份（与 JS makeRefKey 一致）。 */
export function makeRefKey(parts: RefKeyParts = {}): RefKey {
  const key = makeFenceKey(parts);
  if (!key.backendNodeId) throw new Error('RefKey 需要 backendNodeId');
  return key;
}

/** 是否具备节点身份 + 文档身份（JS isFullRefKey）。 */
export function isFullRefKey(key: RefKey | null | undefined): boolean {
  return Boolean(key && key.backendNodeId && key.documentId);
}

/** 可用于日志/断言的 ref 身份串（JS refKeyId）。 */
export function refKeyId(key: RefKey): string {
  return [
    key.documentId,
    key.frameId,
    key.backendNodeId === null ? '-' : key.backendNodeId,
    key.revision === null ? '-' : key.revision,
  ].join(':');
}

/** 两个 RefKey 是否指向同一节点（revision/generation 缺省视为通配，同 JS sameRef）。 */
export function sameRef(a: RefKey | null | undefined, b: RefKey | null | undefined): boolean {
  if (!a || !b) return false;
  return a.backendNodeId === b.backendNodeId
    && a.frameId === b.frameId
    && a.documentId === b.documentId
    && (a.revision === null || b.revision === null || a.revision === b.revision)
    && (a.generation === null || b.generation === null || a.generation === b.generation);
}

// ---------------------------------------------------------------------------
// 失效判定（纯函数）
// ---------------------------------------------------------------------------

/** ref 登记时的完整身份快照：RefKey + 稳定性签名 + 登记代际。 */
export interface RefSignatureEntry {
  key: RefKey;
  signature: string;
  generation: number;
}

/** 动作/读取方对 ref 的期望身份（全部可选，给了才比较）。 */
export interface RefExpectation {
  documentId?: string | null;
  generation?: number | null;
  signature?: string | null;
  revision?: number | null;
  frameId?: number | null;
  backendNodeId?: number | null;
}

export type StaleReason =
  | 'missing'
  | 'stale_document'
  | 'stale_generation'
  | 'stale_signature'
  | 'stale_revision'
  | 'stale_frame'
  | 'stale_backend';

export type RefAssessment =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: StaleReason; readonly message: string };

/** 不同的失效原因对应的用户可见提示（与 JS RefRegistry.resolve 逐字符一致）。 */
export const STALE_REF_MESSAGES: Readonly<Record<StaleReason, string>> = Object.freeze({
  missing: 'ref 不在当前注册表里，请重新 observe',
  stale_document: 'ref 属于旧 document，请重新 observe',
  stale_generation: 'ref 属于旧 generation，请重新 observe',
  stale_signature: 'ref 稳定性签名与当前文档不匹配，请重新 observe',
  stale_revision: 'ref 与当前 revision 不匹配，请重新 observe',
  stale_frame: 'ref 与当前 frame 不匹配',
  stale_backend: 'ref 与节点身份不匹配',
});

const REF_STALE_CODE = 'E_STALE_REF';
const OBSERVATION_STALE_CODE = 'E_OBSERVATION_STALE';

/**
 * 比较“登记时的 ref 身份”和“期望身份”。
 *
 * 判定顺序与 JS RefRegistry.resolve 相同：document → generation → signature →
 * revision → frame → backend。没有条目（或条目为空）即 `missing`。
 */
export function assessRefMatch(
  entry: RefSignatureEntry | null | undefined,
  expected: RefExpectation = {},
): RefAssessment {
  if (!entry || !entry.key) {
    return { ok: false, reason: 'missing', message: STALE_REF_MESSAGES.missing };
  }
  const key = entry.key;
  if (expected.documentId && key.documentId !== expected.documentId) {
    return { ok: false, reason: 'stale_document', message: STALE_REF_MESSAGES.stale_document };
  }
  if (expected.generation !== undefined && expected.generation !== null && Number(expected.generation) !== Number(entry.generation)) {
    return { ok: false, reason: 'stale_generation', message: STALE_REF_MESSAGES.stale_generation };
  }
  if (expected.signature && entry.signature && expected.signature !== entry.signature) {
    return { ok: false, reason: 'stale_signature', message: STALE_REF_MESSAGES.stale_signature };
  }
  if (Number.isInteger(expected.revision) && key.revision !== expected.revision) {
    return { ok: false, reason: 'stale_revision', message: STALE_REF_MESSAGES.stale_revision };
  }
  if (Number.isInteger(expected.frameId) && key.frameId !== expected.frameId) {
    return { ok: false, reason: 'stale_frame', message: STALE_REF_MESSAGES.stale_frame };
  }
  const expectedBackend = positiveInteger(expected.backendNodeId);
  if (expectedBackend !== null && key.backendNodeId !== expectedBackend) {
    return { ok: false, reason: 'stale_backend', message: STALE_REF_MESSAGES.stale_backend };
  }
  return { ok: true };
}

/** ref 失效的统一错误码（本批所有 ref 动作都用它）。 */
export function staleRefCode(): string {
  return REF_STALE_CODE;
}

/** 观察结果失效的统一错误码（revision / document 变化后的整页读取）。 */
export function staleObservationCode(): string {
  return OBSERVATION_STALE_CODE;
}

/** 一次观察的身份戳：documentId + revision（+ 可选签名/代际）。 */
export interface ObservationStamp {
  documentId?: string | null;
  revision?: number | null;
  signature?: string | null;
  generation?: number | null;
}

export type ObservationFreshness =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: typeof OBSERVATION_STALE_CODE; readonly reason: 'stale_document' | 'stale_generation' | 'stale_revision'; readonly message: string };

/**
 * 观察结果是否还能用于读取/动作（整页 revision 级校验）。
 *
 * 与 ref 级校验分开：ref 级失效回 E_STALE_REF（该重新 observe 取新 ref），
 * 整页观察失效回 E_OBSERVATION_STALE（旧 observation 收据不可用）。
 * 只在调用方确实给了 observed 的 revision/documentId 时才判定，缺省不做推断。
 */
export function assessObservationFreshness(
  observed: ObservationStamp | null | undefined,
  current: ObservationStamp | null | undefined,
): ObservationFreshness {
  if (!observed || !current) return { ok: true };
  const observedDocument = nonEmpty(observed.documentId);
  const currentDocument = nonEmpty(current.documentId);
  if (observedDocument && currentDocument && observedDocument !== currentDocument) {
    return {
      ok: false,
      code: 'E_OBSERVATION_STALE',
      reason: 'stale_document',
      message: 'observation 属于旧 document（页面已导航/重建），请重新 observe',
    };
  }
  if (Number.isInteger(observed.generation) && Number.isInteger(current.generation)
    && Number(observed.generation) !== Number(current.generation)) {
    return {
      ok: false,
      code: 'E_OBSERVATION_STALE',
      reason: 'stale_generation',
      message: 'observation 属于旧 generation，请重新 observe',
    };
  }
  if (Number.isInteger(observed.revision) && Number.isInteger(current.revision)
    && Number(observed.revision) !== Number(current.revision)) {
    return {
      ok: false,
      code: 'E_OBSERVATION_STALE',
      reason: 'stale_revision',
      message: 'observation 的 DOM revision 已变化（' + String(observed.revision) + ' → ' + String(current.revision) + '），请重新 observe',
    };
  }
  return { ok: true };
}
