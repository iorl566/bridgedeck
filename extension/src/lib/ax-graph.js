// lib/ax-graph.js —— 把 AX 父子关系并入 VOM 图（纯函数）。
//
// 页面图（vom.graph）只表达 DOM containment + ARIA ownership。AX 树能补上
// 浏览器实际暴露的父子关系（例如 shadow/DOM 重排后 AX 重建），并入后统一成
// `type: "ax"` 的边：
// - 端点仍在图里的（观察节点带 `.ax.nodeId`）直接复用图内 id；
// - AX 树里的中间节点没有对应 DOM 观察节点时，补一个 `ax:<nodeId>` 上下文节点
//   （只放 role，不放 name/text，控制体积与隐私）；
// - 去重、限流（默认 300 条边 / 200 个上下文节点），超限标记 truncated。

export const AX_GRAPH_LIMITS = Object.freeze({ edges: 300, nodes: 200 });

function limitOf(value, fallback, max) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.min(Math.round(num), max);
}

function emptyCounts(payload) {
  const counts = payload && payload.counts && typeof payload.counts === 'object' ? payload.counts : {};
  return {
    nodes: Number.isFinite(counts.nodes) ? counts.nodes : 0,
    edges: Number.isFinite(counts.edges) ? counts.edges : 0,
    byType: counts.byType && typeof counts.byType === 'object' ? { ...counts.byType } : {},
  };
}

/**
 * @param {object} payload buildVomGraph().payload
 * @param {{axNodes?:object[], nodes?:object[], info?:Map, limits?:{edges?:number,nodes?:number}}} options
 * @returns {{graph:object, addedEdges:number, addedNodes:number, dropped:number}}
 */
export function mergeAxIntoGraph(payload, options = {}) {
  if (!payload || payload.available !== true) return { graph: payload, addedEdges: 0, addedNodes: 0, dropped: 0 };
  const axNodes = Array.isArray(options.axNodes) ? options.axNodes : [];
  if (!axNodes.length) return { graph: payload, addedEdges: 0, addedNodes: 0, dropped: 0 };
  const maxEdges = limitOf(options.limits && options.limits.edges, AX_GRAPH_LIMITS.edges, 2000);
  const maxContext = limitOf(options.limits && options.limits.nodes, AX_GRAPH_LIMITS.nodes, 1000);
  const info = options.info instanceof Map ? options.info : null;
  const axById = new Map();
  for (const ax of axNodes) {
    if (ax && ax.nodeId !== undefined && ax.nodeId !== null) axById.set(String(ax.nodeId), ax);
  }
  const observedByAx = new Map();
  for (const node of Array.isArray(options.nodes) ? options.nodes : []) {
    if (!node || !node.ax || node.ax.nodeId === undefined || node.ax.nodeId === null) continue;
    const record = info ? info.get(node) : null;
    if (record && record.id) observedByAx.set(String(node.ax.nodeId), record.id);
  }
  const ids = new Set(payload.nodes.map((node) => node.id));
  const contextNodes = [];
  const contextIds = new Set();
  const contextNodeId = (axNodeId) => {
    const existing = observedByAx.get(String(axNodeId));
    if (existing) return existing;
    const id = 'ax:' + axNodeId;
    if (ids.has(id)) return id;
    if (contextNodes.length >= maxContext) return null;
    const ax = axById.get(String(axNodeId)) || null;
    ids.add(id);
    contextIds.add(id);
    contextNodes.push({
      id,
      ref: null,
      stableRef: null,
      tag: null,
      role: ax && ax.role ? String(ax.role) : null,
      domId: null,
      parentId: null,
      observed: false,
      ax: true,
    });
    return id;
  };

  const edges = payload.edges.slice();
  const seen = new Set(edges.map((edge) => edge.type + '\u0000' + edge.from + '\u0000' + edge.to));
  let dropped = 0;
  let addedEdges = 0;
  for (const ax of axNodes) {
    if (!ax || ax.nodeId === undefined || ax.nodeId === null) continue;
    if (ax.parentId === undefined || ax.parentId === null) continue;
    if (addedEdges >= maxEdges) {
      dropped += 1;
      continue;
    }
    const toId = contextNodeId(ax.nodeId);
    const fromId = contextNodeId(ax.parentId);
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
  const byId = new Map(edges.map((edge) => [edge.to, edge]));
  for (const node of contextNodes) {
    if (node.parentId) continue;
    const edge = byId.get(node.id);
    if (edge && !contextIds.has(edge.from)) node.parentId = edge.from;
  }

  const counts = emptyCounts(payload);
  counts.nodes = payload.nodes.length + contextNodes.length;
  counts.edges = edges.length;
  counts.byType.ax = (counts.byType.ax || 0) + addedEdges;
  const graph = {
    ...payload,
    nodes: payload.nodes.concat(contextNodes),
    edges,
    counts,
    truncated: payload.truncated === true || dropped > 0,
  };
  return { graph, addedEdges, addedNodes: contextNodes.length, dropped };
}
