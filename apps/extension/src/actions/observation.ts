// src/actions/observation.ts —— observe 结果的归一：ref 明细、stableRef、observationId、缓存身份。
//
// 页面侧（内容脚本）只回“它看见的节点”：ref/role/name/tag/id。这里补齐 JS 扩展
// ref-details.js 的语义：
// - identity = cdpSessionId|documentId|frameId|tag|id|role|name
// - identityKey = 'i-' + hash(identity)
// - stableRef  = 's-' + hash(identity + '#' + 同 identity 出现序号)
// 这样同一个页面节点在多次 observe 之间、甚至跨 revision 都能被 stableRef 认出来；
// 与 JS 的差别只是：本批拿不到 backendNodeId，签名由 identity 兜底（见 refs/signature.ts）。
//
// 同时把 observe 结果整理成 daemon 期望的形状（observation/refs/revision/refDetails/
// observationId/url/title），供 CLI/MCP 直接消费。

import type { ContentObserveResult } from '../content/protocol.ts';
import { signatureHash } from '../refs/signature.ts';
import type { ObservationInput, ObservationRefInput } from '../refs/registry.ts';

/** observe 结果里单个 ref 的完整明细（对外可见，E2E/CLI 会读 refDetails）。 */
export interface ObservationRefDetail {
  ref: string;
  role: string | null;
  name: string | null;
  tag: string;
  id: string | null;
  stableRef: string;
  identityKey: string;
  identity: string;
  backendNodeId: null;
  frameId: number;
  cdpSessionId: string | null;
  documentId: string;
  revision: number | null;
  /** 命中测试结论（self/descendant/ancestor/blocked/pointer-events-none/offscreen/…；35b）。 */
  hitTest?: string | null;
  /** 被谁挡住（hitTest=blocked 时；{tag,role,id,name}）。 */
  occludedBy?: { tag?: string | null; role?: string | null; id?: string | null; name?: string | null } | null;
  /** 是否与视口相交（35b）。 */
  inViewport?: boolean | null;
  /** 计算样式的 pointer-events（35b）。 */
  pointerEvents?: string | null;
}

export interface ObservationContext {
  frameId?: number | null;
  cdpSessionId?: string | null;
  documentId?: string | null;
  revision?: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * 为 observe 结果里的每个 ref 计算 identity/stableRef。
 * 同一个 identity 出现多次（同 tag/id/role/name 的重复控件）用出现序号区分，顺序稳定。
 */
export function buildObservationRefDetails(
  result: ContentObserveResult,
  context: ObservationContext = {},
): ObservationRefDetail[] {
  const documentId = text(result.documentId) || text(context.documentId);
  const revision = Number.isInteger(result.revision) ? result.revision : (Number.isInteger(context.revision) ? Number(context.revision) : null);
  const frameId = Number.isInteger(context.frameId) ? Number(context.frameId) : 0;
  const cdpSessionId = context.cdpSessionId ? String(context.cdpSessionId) : null;
  const used = new Map<string, number>();
  const nodes = Array.isArray(result.nodes) ? result.nodes : [];
  const details: ObservationRefDetail[] = [];
  for (const node of nodes) {
    if (!isRecord(node)) continue;
    const ref = text(node.ref);
    if (!ref.startsWith('@e')) continue;
    const tag = text(node.tag);
    const id = typeof node.id === 'string' && node.id ? node.id : null;
    const role = typeof node.role === 'string' && node.role ? node.role : null;
    const name = typeof node.name === 'string' && node.name ? node.name.slice(0, 120) : null;
    // 内容脚本如提供 CDP 会话标识（`<tabId>:<frameId>`）就透传；缺省保持 null（不伪造）。
    // 35b 断言 refDetails.every(cdpSessionId.endsWith(':0'))，主文档 = frame 0。
    const nodeCdpSessionId = typeof node.cdpSessionId === 'string' && node.cdpSessionId ? node.cdpSessionId : null;
    const effectiveCdpSessionId = nodeCdpSessionId ?? cdpSessionId;
    const identity = [effectiveCdpSessionId || '', documentId, frameId, tag, id || '', role || '', name || ''].join('|');
    const identityKey = 'i-' + signatureHash(identity);
    const count = (used.get(identityKey) ?? 0) + 1;
    used.set(identityKey, count);
    const stableRef = 's-' + signatureHash(identity + '#' + count);
    details.push({
      ref,
      role,
      name,
      tag,
      id,
      stableRef,
      identityKey,
      identity,
      backendNodeId: null,
      frameId,
      cdpSessionId: effectiveCdpSessionId,
      documentId,
      revision,
    });
  }
  return details;
}

/** ref 明细 → 注册表登记输入（identity/stableRef 已存在，签名由注册表算）。 */
export function refDetailsToObservationInput(
  documentId: string,
  revision: number | null,
  details: readonly ObservationRefDetail[],
  context: ObservationContext = {},
): ObservationInput {
  const refs: ObservationRefInput[] = details.map((detail) => ({
    ref: detail.ref,
    role: detail.role,
    name: detail.name,
    identity: detail.identity,
    stableRef: detail.stableRef,
    backendNodeId: detail.backendNodeId,
  }));
  return {
    documentId,
    revision,
    frameId: context.frameId ?? 0,
    cdpSessionId: context.cdpSessionId ?? null,
    refs,
  };
}

/** observationId：与 JS 同形 `ob_<tabId 前4位>_<12 hex>`；random 可注入便于单测。 */
export function newObservationId(tabId: number | string, random: () => number = Math.random): string {
  const seed = String(tabId ?? '').slice(0, 4);
  let suffix = '';
  for (let index = 0; index < 6; index += 1) {
    const byte = Math.floor(Math.max(0, Math.min(0.999999, random())) * 256);
    suffix += byte.toString(16).padStart(2, '0');
  }
  return 'ob_' + (seed ? seed + '_' : '') + suffix;
}

/** observe 的对外结果（daemon → CLI 原样透传的字段都在这里声明）。 */
export interface ObserveActionResult {
  url: string;
  title: string;
  observation: string;
  refs: number;
  revision: number;
  documentId: string;
  observationId: string;
  refDetails: ObservationRefDetail[];
  nodeCount: number;
  filtered: number;
  truncated: boolean;
}

/**
 * 把内容脚本的 observe 结果整理成对外结果。
 * 空节点/非法节点在这里被丢弃，但 refs 计数与 refDetails 保持一致（不虚报）。
 */
export function toObserveActionResult(
  result: ContentObserveResult,
  options: { tabId: number; observationId?: string; random?: () => number; context?: ObservationContext },
): { action: ObserveActionResult; input: ObservationInput } {
  const documentId = text(result.documentId) || text(options.context?.documentId);
  const revision = Number.isInteger(result.revision) ? result.revision : null;
  const details = buildObservationRefDetails(result, { ...options.context, documentId });
  const input = refDetailsToObservationInput(documentId, revision, details, options.context);
  const action: ObserveActionResult = {
    url: text(result.url),
    title: text(result.title),
    observation: text(result.observation),
    refs: details.length,
    revision: revision === null ? 0 : revision,
    documentId,
    observationId: options.observationId ?? newObservationId(options.tabId, options.random),
    refDetails: details,
    nodeCount: details.length,
    filtered: Number.isInteger(result.filtered) ? Number(result.filtered) : 0,
    truncated: result.truncated === true,
  };
  return { action, input };
}
