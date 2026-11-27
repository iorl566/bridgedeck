// packages/vom/src/graph.ts —— VOM 完整关系图的规范化 + AX 父子边并入（类型化移植）。
//
// 源：extension/src/lib/vom-graph.js 与 extension/src/lib/ax-graph.js（差分测试逐字段对拍）。
//
// 页面侧只负责收集一张“元素级”的图：
//   { nodes: [{ key, ref, tag, domId, role, parentKey, frameIndex, srcUrl }],
//     edges: [{ type, from, to }], truncated }
// 这里把它规范化成对 Agent 稳定的公开结构：
//   - 每个节点有唯一 `id`（observed.vomId > ref > stableRef > `vom:<key>`；重名时追加 `~<key>`）；
//   - 边端点全部换成 id，未知端点丢弃，按 type+from+to 去重；
//   - 祖先链换成 id 链（近 → 远），并给出 roots；
//   - 有上限（nodes/edges）与 truncated 标记，避免大页面把观测撑爆。
//
// TS 扩展（不改变 JS 语义）：observed/raw 节点可带 `vomId`，让 TS 内容脚本用 rich 节点 id
// 作为公开 id（与 vom.nodes[].id / facts 祖先链对齐）。JS 对照输入没有 vomId，输出逐字段一致。
//
// AX：没有 CDP 的 TS 运行时没有真实 AX 树；调用方用 DOM 投影出 `{nodeId,parentId,role}`，
// 这里仍然按 JS 语义并入 `type:"ax"` 边，并给未观察到的 AX 节点补 `ax:<nodeId>` 上下文节点。

import { affordanceForNode } from './affordance.ts';
import { normalizeRowAnchor } from './rows.ts';
import type { AffordanceResult, RowAnchor, RowAnchorInput } from './types.ts';

/** 图节点/边默认上限（与 JS 基线一致）。 */
export const VOM_GRAPH_DEFAULT_LIMITS: Readonly<{ nodes: number; edges: number }> = Object.freeze({
  nodes: 600,
  edges: 1500,
});

/** AX 并入默认上限（与 JS 基线一致）。 */
export const AX_GRAPH_LIMITS: Readonly<{ edges: number; nodes: number }> = Object.freeze({
  edges: 300,
  nodes: 200,
});

/** 页面侧原始图节点（raw page graph）。 */
export interface VomGraphRawNode {
  readonly key?: string | null;
  /** TS 扩展：rich 节点 id（公开 id 优先取它，保证与 vom.nodes/facts 祖先链对齐）。 */
  readonly vomId?: string | null;
  readonly ref?: string | null;
  readonly tag?: string | null;
  readonly domId?: string | null;
  readonly role?: string | null;
  readonly parentKey?: string | null;
  readonly parentId?: string | null;
  readonly frameIndex?: number | null;
  readonly srcUrl?: string | null;
  readonly anchor?: unknown;
}

/** 页面侧原始图边。 */
export interface VomGraphRawEdge {
  readonly type?: string | null;
  readonly from?: string | null;
  readonly to?: string | null;
}

/** 页面侧原始图（缺省/空 nodes 时 available=false）。 */
export interface VomGraphRawFacts {
  readonly available?: boolean;
  readonly nodes?: readonly VomGraphRawNode[] | null;
  readonly edges?: readonly VomGraphRawEdge[] | null;
  readonly roots?: readonly string[] | null;
  readonly truncated?: boolean;
}

/** 已观察节点（rich 节点）投影：graphKey 映射回原始图节点，vomId 作为公开 id。 */
export interface VomGraphObservedNode {
  readonly ref?: string | null;
  readonly stableRef?: string | null;
  readonly vomId?: string | null;
  readonly graphKey?: string | null;
  readonly tag?: string | null;
  readonly role?: string | null;
  readonly name?: string | null;
  readonly anchor?: unknown;
  readonly ax?: { readonly nodeId?: string | number | null } | null;
  readonly [key: string]: unknown;
}

/** 公开图节点。 */
export interface VomGraphPublicNode {
  id: string;
  ref: string | null;
  stableRef: string | null;
  tag: string | null;
  role: string | null;
  domId: string | null;
  /** 原始图字段：iframe 序号/绝对 src（非 iframe 节点为 null；AX 上下文节点没有）。 */
  frameIndex?: number | null;
  srcUrl?: string | null;
  /** 观察节点的类型化 affordance（非观察节点/上下文节点没有）。 */
  affordance?: AffordanceResult;
  /** 行事实（虚拟列表锚点），存在时保留。 */
  anchor?: RowAnchor;
  parentId: string | null;
  /** 祖先 id 链（近 → 远；AX 上下文节点与 frame 节点可能没有）。 */
  ancestorIds?: string[];
  observed: boolean;
  /** AX 上下文节点标记（mergeAxIntoGraph 补充）。 */
  ax?: true;
  /** 跨 frame 子图节点标记（frame-vom 补充）。 */
  frame?: true;
  frameId?: number;
  url?: string | null;
  parentFrameId?: number | null;
}

/** 公开图统计。 */
export interface VomGraphCounts {
  nodes: number;
  edges: number;
  byType: Record<string, number>;
}

/** 公开图（observe 的 vom.graph）。 */
export interface VomGraphPayload {
  available: boolean;
  nodes: VomGraphPublicNode[];
  edges: Array<{ type: string; from: string; to: string }>;
  roots: string[];
  counts: VomGraphCounts;
  truncated: boolean;
}

/** buildVomGraph 的观察节点映射（Map 键是传入的 observed 对象本身）。 */
export interface VomGraphNodeInfo {
  id: string;
  parentId: string;
  ancestorIds: string[];
}

/** buildVomGraph 返回。 */
export interface VomGraphResult {
  available: boolean;
  payload: VomGraphPayload;
  info: Map<object, VomGraphNodeInfo>;
}

/** buildVomGraph 选项。 */
export interface BuildVomGraphOptions {
  readonly graph?: VomGraphRawFacts | null;
  readonly nodes?: readonly VomGraphObservedNode[] | null;
  readonly limits?: { readonly nodes?: unknown; readonly edges?: unknown };
}

function limitOf(value: unknown, fallback: number, max: number): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) return fallback;
  return Math.min(number, max);
}

function emptyPayload(): VomGraphPayload {
  return {
    available: false,
    nodes: [],
    edges: [],
    roots: [],
    counts: { nodes: 0, edges: 0, byType: {} },
    truncated: false,
  };
}

/** 观察节点 → 公开 id（vomId > ref > stableRef；JS 基线只有后两项）。 */
function idForObserved(node: VomGraphObservedNode | null | undefined): string {
  if (!node || typeof node !== 'object') return '';
  if (typeof node.vomId === 'string' && node.vomId) return node.vomId;
  if (typeof node.ref === 'string' && node.ref) return node.ref;
  if (typeof node.stableRef === 'string' && node.stableRef) return node.stableRef;
  return '';
}

function nodeKeyOf(node: VomGraphRawNode): string {
  if (typeof node.key === 'string' && node.key) return node.key;
  if (typeof node.vomId === 'string' && node.vomId) return node.vomId;
  return '';
}

function parentKeyOf(node: VomGraphRawNode): string {
  if (typeof node.parentKey === 'string' && node.parentKey) return node.parentKey;
  if (typeof node.parentId === 'string' && node.parentId) return node.parentId;
  return '';
}

function rawAnchorOf(node: VomGraphRawNode): unknown {
  return node.anchor;
}

/**
 * 原始图 + 观察节点 → 公开图。
 *
 * @param options.graph 页面侧原始图（nodes 的 key 是页面 key）
 * @param options.nodes 已观察节点（带 graphKey/vomId/ref/stableRef）
 */
export function buildVomGraph(options: BuildVomGraphOptions = {}): VomGraphResult {
  const maxNodes = limitOf(options.limits && options.limits.nodes, VOM_GRAPH_DEFAULT_LIMITS.nodes, 5000);
  const maxEdges = limitOf(options.limits && options.limits.edges, VOM_GRAPH_DEFAULT_LIMITS.edges, 5000);
  const list = Array.isArray(options.nodes) ? options.nodes : [];
  const graph = options.graph ?? null;
  const rawNodes = graph && Array.isArray(graph.nodes) ? graph.nodes : [];
  const rawEdges = graph && Array.isArray(graph.edges) ? graph.edges : [];
  const info = new Map<object, VomGraphNodeInfo>();
  if (!rawNodes.length) {
    return { available: false, payload: emptyPayload(), info };
  }

  const observedByKey = new Map<string, VomGraphObservedNode>();
  for (const node of list) {
    if (node && typeof node.graphKey === 'string' && node.graphKey) observedByKey.set(node.graphKey, node);
  }

  const usedIds = new Set<string>();
  const keyToId = new Map<string, string>();
  const publicNodes: VomGraphPublicNode[] = [];
  const rawByKey = new Map<string, VomGraphRawNode>();
  let nodeTruncated = false;
  for (const raw of rawNodes) {
    if (!raw || !nodeKeyOf(raw)) continue;
    if (publicNodes.length >= maxNodes) {
      nodeTruncated = true;
      break;
    }
    const key = nodeKeyOf(raw);
    const observed = observedByKey.get(key) ?? null;
    const base = observed
      ? idForObserved(observed)
      : (typeof raw.vomId === 'string' && raw.vomId ? raw.vomId : (typeof raw.ref === 'string' && raw.ref ? raw.ref : ''));
    let id = base || 'vom:' + key;
    if (usedIds.has(id)) id = id + '~' + key;
    usedIds.add(id);
    keyToId.set(key, id);
    rawByKey.set(key, raw);
    const observedAnchor = observed ? observed.anchor : null;
    const anchor = normalizeRowAnchor((observedAnchor ?? rawAnchorOf(raw)) as RowAnchorInput);
    const entry: VomGraphPublicNode = {
      id,
      ref: observed ? (observed.ref || null) : (raw.ref || null),
      stableRef: observed && observed.stableRef ? observed.stableRef : null,
      tag: raw.tag || (observed && observed.tag) || null,
      role: raw.role || (observed && observed.role) || null,
      domId: raw.domId || null,
      frameIndex: Number.isInteger(raw.frameIndex) ? Number(raw.frameIndex) : null,
      srcUrl: raw.srcUrl || null,
      // 图节点也带 affordance：没有富化节点时退回页面图的 tag/role 事实。
      affordance: affordanceForNode((observed ?? { tag: raw.tag, role: raw.role, ref: raw.ref, name: null }) as never),
      // 行事实同 payload：图里也能直接看到 anchor，跨帧子图（frame-vom）按 spread 保留。
      ...(anchor ? { anchor } : {}),
      parentId: null,
      ancestorIds: [],
      observed: Boolean(observed),
    };
    publicNodes.push(entry);
    if (observed) info.set(observed, { id, parentId: '', ancestorIds: [] });
  }

  // parent + roots
  const byId = new Map<string, VomGraphPublicNode>();
  for (const entry of publicNodes) byId.set(entry.id, entry);
  const roots: string[] = [];
  for (const raw of rawNodes) {
    if (!raw) continue;
    const id = keyToId.get(nodeKeyOf(raw));
    if (!id) continue;
    const parentKey = parentKeyOf(raw);
    const parentId = parentKey ? keyToId.get(parentKey) || '' : '';
    const entry = byId.get(id);
    if (!entry) continue;
    entry.parentId = parentId || null;
    if (!parentId) roots.push(id);
  }

  // ancestorIds（近 → 远）
  const ancestorOf = (id: string): string[] => {
    const out: string[] = [];
    let current = byId.get(id);
    let guard = 0;
    while (current && current.parentId && guard < 32) {
      out.push(current.parentId);
      current = byId.get(current.parentId);
      guard += 1;
    }
    return out;
  };
  for (const entry of publicNodes) entry.ancestorIds = ancestorOf(entry.id);
  for (const [, record] of info) {
    const node = byId.get(record.id);
    record.parentId = (node && node.parentId) || '';
    record.ancestorIds = node ? node.ancestorIds ?? [] : [];
  }

  // edges：端点换成 id，未知端点丢弃，去重
  const edgeSeen = new Set<string>();
  const edges: Array<{ type: string; from: string; to: string }> = [];
  const byType: Record<string, number> = {};
  for (const edge of rawEdges) {
    if (!edge || !edge.type) continue;
    if (edges.length >= maxEdges) break;
    const from = edge.from == null ? '' : keyToId.get(String(edge.from)) || '';
    const to = edge.to == null ? '' : keyToId.get(String(edge.to)) || '';
    if (!from || !to || from === to) continue;
    const dedupe = edge.type + '\u0000' + from + '\u0000' + to;
    if (edgeSeen.has(dedupe)) continue;
    edgeSeen.add(dedupe);
    edges.push({ type: String(edge.type), from, to });
    byType[String(edge.type)] = (byType[String(edge.type)] || 0) + 1;
  }
  void rawByKey;

  const payload: VomGraphPayload = {
    available: true,
    nodes: publicNodes,
    edges,
    roots,
    counts: { nodes: publicNodes.length, edges: edges.length, byType },
    truncated: nodeTruncated || Boolean(graph && graph.truncated) || edges.length >= maxEdges,
  };
  return { available: true, payload, info };
}

/** 旧路径（没有页面图）用的稳定 id：ref > stableRef > vom:<序号>。 */
export function fallbackNodeId(node: VomGraphObservedNode | null | undefined, index = 0): string {
  const observed = idForObserved(node);
  return observed || 'vom:i' + String(index);
}

/** AX 投影节点（无 CDP 时由 DOM 投影；nodeId 是 AX 节点标识）。 */
export interface VomAxProjectionNode {
  readonly nodeId?: string | number | null;
  readonly parentId?: string | number | null;
  readonly role?: string | null;
}

/** mergeAxIntoGraph 选项。 */
export interface MergeAxIntoGraphOptions {
  readonly axNodes?: readonly VomAxProjectionNode[] | null;
  readonly nodes?: readonly VomGraphObservedNode[] | null;
  readonly info?: Map<object, VomGraphNodeInfo> | null;
  readonly limits?: { readonly edges?: unknown; readonly nodes?: unknown };
}

/** mergeAxIntoGraph 返回。 */
export interface MergeAxIntoGraphResult {
  graph: VomGraphPayload;
  addedEdges: number;
  addedNodes: number;
  dropped: number;
}

function contextNode(axNodeId: string, role: string | null): VomGraphPublicNode {
  return {
    id: 'ax:' + axNodeId,
    ref: null,
    stableRef: null,
    tag: null,
    role,
    domId: null,
    parentId: null,
    observed: false,
    ax: true,
  };
}

/**
 * 把 AX 父子关系并入 VOM 图（纯函数）。
 *
 * - 端点仍在图里的（观察节点带 `.ax.nodeId`）直接复用图内 id；
 * - AX 树里的中间节点没有对应 DOM 观察节点时，补一个 `ax:<nodeId>` 上下文节点
 *   （只放 role，不放 name/text，控制体积与隐私）；
 * - 去重、限流（默认 300 条边 / 200 个上下文节点），超限标记 truncated。
 */
export function mergeAxIntoGraph(
  payload: VomGraphPayload | null | undefined,
  options: MergeAxIntoGraphOptions = {},
): MergeAxIntoGraphResult {
  if (!payload || payload.available !== true) return { graph: payload as VomGraphPayload, addedEdges: 0, addedNodes: 0, dropped: 0 };
  const axNodes = Array.isArray(options.axNodes) ? options.axNodes : [];
  if (!axNodes.length) return { graph: payload, addedEdges: 0, addedNodes: 0, dropped: 0 };
  const maxEdges = limitOf(options.limits && options.limits.edges, AX_GRAPH_LIMITS.edges, 2000);
  const maxContext = limitOf(options.limits && options.limits.nodes, AX_GRAPH_LIMITS.nodes, 1000);
  const info = options.info instanceof Map ? options.info : null;
  const axById = new Map<string, VomAxProjectionNode>();
  for (const ax of axNodes) {
    if (ax && ax.nodeId !== undefined && ax.nodeId !== null) axById.set(String(ax.nodeId), ax);
  }
  const observedByAx = new Map<string, string>();
  for (const node of Array.isArray(options.nodes) ? options.nodes : []) {
    if (!node || !node.ax || node.ax.nodeId === undefined || node.ax.nodeId === null) continue;
    const record = info ? info.get(node) : null;
    if (record && record.id) observedByAx.set(String(node.ax.nodeId), record.id);
  }
  const ids = new Set<string>();
  for (const node of payload.nodes) ids.add(node.id);
  const contextNodes: VomGraphPublicNode[] = [];
  const contextIds = new Set<string>();
  const contextNodeId = (axNodeId: string): string | null => {
    const existing = observedByAx.get(axNodeId);
    if (existing) return existing;
    const id = 'ax:' + axNodeId;
    if (ids.has(id)) return id;
    if (contextNodes.length >= maxContext) return null;
    const ax = axById.get(axNodeId) ?? null;
    ids.add(id);
    contextIds.add(id);
    const node = contextNode(axNodeId, ax && ax.role ? String(ax.role) : null);
    contextNodes.push(node);
    return id;
  };

  const edges = payload.edges.slice();
  const seen = new Set<string>();
  for (const edge of edges) seen.add(edge.type + '\u0000' + edge.from + '\u0000' + edge.to);
  let dropped = 0;
  let addedEdges = 0;
  for (const ax of axNodes) {
    if (!ax || ax.nodeId === undefined || ax.nodeId === null) continue;
    if (ax.parentId === undefined || ax.parentId === null) continue;
    if (addedEdges >= maxEdges) {
      dropped += 1;
      continue;
    }
    const toId = contextNodeId(String(ax.nodeId));
    const fromId = contextNodeId(String(ax.parentId));
    if (!toId || !fromId || toId === fromId) {
      dropped += 1;
      continue;
    }
    const key = 'ax\u0000' + fromId + '\u0000' + toId;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ type: 'ax', from: fromId, to: toId });
    addedEdges += 1;
  }

  // AX 上下文节点补 parentId（只补上下文节点，观察节点的 DOM parentId 不动）。
  const byTarget = new Map<string, { type: string; from: string; to: string }>();
  for (const edge of edges) if (!byTarget.has(edge.to)) byTarget.set(edge.to, edge);
  for (const node of contextNodes) {
    if (node.parentId) continue;
    const edge = byTarget.get(node.id);
    if (edge && !contextIds.has(edge.from)) node.parentId = edge.from;
  }

  const byType: Record<string, number> = { ...payload.counts.byType };
  byType.ax = (byType.ax || 0) + addedEdges;
  const counts: VomGraphCounts = {
    nodes: payload.nodes.length + contextNodes.length,
    edges: edges.length,
    byType,
  };
  const graph: VomGraphPayload = {
    ...payload,
    nodes: payload.nodes.concat(contextNodes),
    edges,
    counts,
    truncated: payload.truncated === true || dropped > 0,
  };
  return { graph, addedEdges, addedNodes: contextNodes.length, dropped };
}
