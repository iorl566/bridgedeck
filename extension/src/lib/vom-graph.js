// lib/vom-graph.js —— VOM 完整关系图的规范化（纯函数）。
//
// 页面侧（page-lib）负责收集一张“元素级”的图：
//   { nodes: [{ key, ref, tag, domId, role, parentKey }], edges: [{ type, from, to }], truncated }
// 这里把它规范化成对 Agent 稳定的公开结构：
//   - 每个节点有唯一 `id`（ref > stableRef > `vom:<key>`；重名时追加 key 保证唯一）；
//   - 边端点全部换成 id，未知端点丢弃，按 type+from+to 去重；
//   - 祖先链换成 id 链（近 → 远），并给出 roots；
//   - 有上限（nodes/edges）与 truncated 标记，避免大页面把观测撑爆。
//
// 没有页面图（旧 AX 管线 / 降级观察）时返回 available:false，调用方保留旧的
// best-effort ancestors 行为。

import { affordanceForNode } from './vom-affordance.js';
import { normalizeRowAnchor } from './vom-rows.js';

export const VOM_GRAPH_DEFAULT_LIMITS = Object.freeze({ nodes: 600, edges: 1500 });

function limitOf(value, fallback) {
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) return fallback;
  return Math.min(num, 5000);
}

function idForObserved(node) {
  if (!node || typeof node !== 'object') return '';
  if (typeof node.ref === 'string' && node.ref) return node.ref;
  if (typeof node.stableRef === 'string' && node.stableRef) return node.stableRef;
  return '';
}

/**
 * @param {{graph?:object|null, nodes?:object[], limits?:{nodes?:number,edges?:number}}} options
 * @returns {{available:boolean, payload:object, info:Map<object,{id:string,parentId:string,ancestorIds:string[]}>}}
 */
export function buildVomGraph({ graph = null, nodes = [], limits = {} } = {}) {
  const maxNodes = limitOf(limits.nodes, VOM_GRAPH_DEFAULT_LIMITS.nodes);
  const maxEdges = limitOf(limits.edges, VOM_GRAPH_DEFAULT_LIMITS.edges);
  const list = Array.isArray(nodes) ? nodes : [];
  const rawNodes = graph && Array.isArray(graph.nodes) ? graph.nodes : [];
  const rawEdges = graph && Array.isArray(graph.edges) ? graph.edges : [];
  const info = new Map();
  if (!rawNodes.length) {
    return {
      available: false,
      payload: { available: false, nodes: [], edges: [], roots: [], counts: { nodes: 0, edges: 0, byType: {} }, truncated: false },
      info,
    };
  }

  const observedByKey = new Map();
  for (const node of list) {
    if (node && typeof node.graphKey === 'string' && node.graphKey) observedByKey.set(node.graphKey, node);
  }

  const usedIds = new Set();
  const keyToId = new Map();
  const publicNodes = [];
  const rawByKey = new Map();
  let nodeTruncated = false;
  for (const raw of rawNodes) {
    if (!raw || typeof raw.key !== 'string' || !raw.key) continue;
    if (publicNodes.length >= maxNodes) { nodeTruncated = true; break; }
    const observed = observedByKey.get(raw.key) || null;
    const base = observed ? idForObserved(observed) : (typeof raw.ref === 'string' && raw.ref ? raw.ref : '');
    let id = base || 'vom:' + raw.key;
    if (usedIds.has(id)) id = id + '~' + raw.key;
    usedIds.add(id);
    keyToId.set(raw.key, id);
    rawByKey.set(raw.key, raw);
    const anchor = normalizeRowAnchor((observed && observed.anchor) || (raw && raw.anchor));
    const entry = {
      id,
      ref: observed ? (observed.ref || null) : (raw.ref || null),
      stableRef: observed && observed.stableRef ? observed.stableRef : null,
      tag: raw.tag || (observed && observed.tag) || null,
      role: raw.role || (observed && observed.role) || null,
      domId: raw.domId || null,
      frameIndex: Number.isInteger(raw.frameIndex) ? raw.frameIndex : null,
      srcUrl: raw.srcUrl || null,
      // 图节点也带 affordance：没有富化节点时退回页面图的 tag/role 事实。
      affordance: affordanceForNode(observed || { tag: raw.tag, role: raw.role, ref: raw.ref, name: raw.name }),
      // 行事实同 payload：图里也能直接看到 anchor，跨帧子图（frame-vom）按 spread 保留。
      ...(anchor ? { anchor } : {}),
      parentId: null,
      observed: Boolean(observed),
    };
    publicNodes.push(entry);
    if (observed) info.set(observed, { id, parentId: '', ancestorIds: [] });
  }

  // parent + roots
  const byId = new Map(publicNodes.map((item) => [item.id, item]));
  const roots = [];
  for (const raw of rawNodes) {
    const id = keyToId.get(raw && raw.key);
    if (!id) continue;
    const parentId = raw.parentKey ? keyToId.get(raw.parentKey) || '' : '';
    byId.get(id).parentId = parentId || null;
    if (!parentId) roots.push(id);
  }

  // ancestorIds（近 → 远）
  const ancestorOf = (id) => {
    const out = [];
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
  for (const [observed, record] of info) {
    const node = byId.get(record.id);
    record.parentId = (node && node.parentId) || '';
    record.ancestorIds = (node && node.ancestorIds) || [];
  }

  // edges：端点换成 id，未知端点丢弃，去重
  const edgeSeen = new Set();
  const edges = [];
  const byType = {};
  for (const edge of rawEdges) {
    if (!edge || !edge.type) continue;
    if (edges.length >= maxEdges) break;
    const from = keyToId.get(edge.from);
    const to = keyToId.get(edge.to);
    if (!from || !to || from === to) continue;
    const dedupe = edge.type + '\u0000' + from + '\u0000' + to;
    if (edgeSeen.has(dedupe)) continue;
    edgeSeen.add(dedupe);
    edges.push({ type: String(edge.type), from, to });
    byType[String(edge.type)] = (byType[String(edge.type)] || 0) + 1;
  }

  const payload = {
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
export function fallbackNodeId(node, index = 0) {
  const observed = idForObserved(node);
  return observed || 'vom:i' + index;
}
