// lib/vom-frame-relations.js —— 跨 frame 关系图（纯函数）。
//
// `observe --frames --vom` 时每个 frame 各自有一份页面图（lib/frame-vom.js 已做命名空间与
// frame 节点）。本模块把这些子图拼成一张“frame 作为节点”的关系层：
//   - frame:<frameId> 是显式节点（role=document / frame），参与 contains/owns 关系；
//   - frame:<frameId> --contains(frame-edge)--> 该 frame 的 roots（真实元素）；
//   - 父帧里的 iframe 元素 --owns(frame-owner)--> 子帧 frame:<childId>；
//   - frame:<parentId> --contains(parent-frame)--> frame:<childId>（frame 树本身也是关系）。
//
// 输入容忍三种形态（都来自既有运行时，不新增 CDP 依赖）：
//   1. lib/frame-vom.js 的整份结果 `{graphs, summary, limits}`；
//   2. frame 列表，每项带 `.vom` 子图（observe-frames 把子图挂在 frame.vom 上）；
//   3. `{frameId, url, parentFrameId, graph|vom}` 的松散数组，或直接是子图数组。
//
// 输出是纯 JSON（可跨 executeScript 边界），每条关系带 confidence/source，多来源合并取最大置信度。

export const VOM_FRAME_RELATIONS_VERSION = 1;

export const FRAME_RELATION_LIMITS = Object.freeze({ frames: 16, relations: 400 });

/** 跨 frame 关系的来源 → 置信度。frame 边是显式结构，置信度高于 DOM 推导。 */
export const FRAME_RELATION_CONFIDENCE = Object.freeze({
  'frame-edge': 0.95,
  'frame-owner': 0.9,
  'parent-frame': 0.9,
});

const FRAME_PREFIX = 'frame:';

function limitOf(value, fallback, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.floor(number), max);
}

function confidenceOf(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(1, Math.max(0, Math.round(number * 100) / 100));
}

/** frame 节点 id（与 lib/frame-vom.js 的命名保持一致）。 */
export function frameNodeIdOf(frameId) {
  const id = Number(frameId);
  return FRAME_PREFIX + (Number.isFinite(id) ? id : String(frameId));
}

function frameIdOfNodeId(id) {
  const text = String(id || '');
  if (!text.startsWith(FRAME_PREFIX)) return null;
  const value = text.slice(FRAME_PREFIX.length);
  return /^-?\d+$/.test(value) ? Number(value) : value;
}

/** Chrome 用 -1 表示主 frame 没有父帧；负值/自身都归一成 null（根帧）。 */
function normalizeParentFrameId(value, frameId = null) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) return null;
  if (frameId != null && number === Number(frameId)) return null;
  return number;
}

function pickGraph(item) {
  if (!item || typeof item !== 'object') return null;
  if (item.graph && typeof item.graph === 'object') return item.graph;
  if (item.vom && typeof item.vom === 'object') return item.vom;
  if (Array.isArray(item.nodes) || Array.isArray(item.edges)) return item;
  return null;
}

/** 把三种输入形态归一成 [{frameId, url, parentFrameId, graph}]；保持输入顺序。 */
export function collectFrameGraphs(input) {
  if (!input) return [];
  const array = Array.isArray(input) ? input : (Array.isArray(input.graphs) ? input.graphs : null);
  if (!array) return [];
  const out = [];
  for (const item of array) {
    if (!item || typeof item !== 'object') continue;
    const graph = pickGraph(item);
    if (!graph) continue;
    const frameId = Number.isFinite(Number(item.frameId)) ? Number(item.frameId) : frameIdOfNodeId(item.frameNodeId);
    if (!Number.isInteger(frameId)) continue;
    out.push({
      frameId,
      url: item.url != null ? String(item.url).slice(0, 300) : null,
      parentFrameId: Number.isInteger(item.parentFrameId) ? item.parentFrameId : null,
      graph,
    });
  }
  return out;
}

function relationRecord(type, from, to, source, confidence, extra) {
  return {
    type,
    from,
    to,
    confidence: confidenceOf(confidence),
    source,
    sources: [source],
    frame: true,
    ...(extra && typeof extra === 'object' ? extra : {}),
  };
}

/**
 * @param {object|Array} input 见文件头三种形态
 * @param {{limits?:{frames?:number,relations?:number}}} [options]
 * @returns {{version:number, frames:object[], nodes:object[], relations:object[],
 *            stats:object, limits:object}}
 */
export function buildCrossFrameRelations(input = {}, options = {}) {
  const collected = collectFrameGraphs(input);
  const maxFrames = limitOf(options.limits && options.limits.frames, FRAME_RELATION_LIMITS.frames, 200);
  const maxRelations = limitOf(options.limits && options.limits.relations, FRAME_RELATION_LIMITS.relations, 5000);
  const frames = collected.slice(0, maxFrames);
  const truncated = collected.length > frames.length;
  const relations = [];
  const index = new Map();
  const frameNodes = new Map();
  const nodeOwnerFrame = new Map();

  const add = (type, from, to, source, confidence, extra) => {
    const left = from == null ? '' : String(from);
    const right = to == null ? '' : String(to);
    if (!left || !right || left === right) return null;
    const key = type + '\u0000' + left + '\u0000' + right;
    const existing = index.get(key);
    const value = confidenceOf(confidence);
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
      if (value > existing.confidence) {
        existing.confidence = value;
        existing.source = source;
      }
      return existing;
    }
    if (relations.length >= maxRelations) return null;
    const record = relationRecord(type, left, right, source, value, extra);
    index.set(key, record);
    relations.push(record);
    return record;
  };

  const addFrameNode = (frameId, info = {}) => {
    const id = frameNodeIdOf(frameId);
    if (!frameNodes.has(id)) {
      frameNodes.set(id, {
        id,
        frameId,
        role: frameId === 0 ? 'document' : 'frame',
        url: info.url || null,
        parentFrameId: Number.isInteger(info.parentFrameId) ? info.parentFrameId : null,
        ownerNodeId: info.ownerNodeId || null,
        available: info.available === true,
        placeholder: info.available !== true,
      });
    } else if (info.available === true) {
      const existing = frameNodes.get(id);
      existing.available = true;
      existing.placeholder = false;
      if (!existing.url && info.url) existing.url = info.url;
      if (!Number.isInteger(existing.parentFrameId) && Number.isInteger(info.parentFrameId)) existing.parentFrameId = info.parentFrameId;
    }
    return frameNodes.get(id);
  };

  // 1) 每帧：frame 节点、roots 的 contains 边、父图里 iframe 元素→子帧节点的 owns 边。
  for (const frame of frames) {
    const graph = frame.graph;
    const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
    const edges = Array.isArray(graph.edges) ? graph.edges : [];
    const id = frameNodeIdOf(frame.frameId);
    const frameNode = nodes.find((node) => node && node.id === id) || null;
    const parentFrameId = frame.parentFrameId != null
      ? normalizeParentFrameId(frame.parentFrameId, frame.frameId)
      : normalizeParentFrameId(frameNode && frameNode.parentFrameId, frame.frameId);
    const ownerNodeId = (frameNode && frameNode.parentId) || null;
    const node = addFrameNode(frame.frameId, {
      url: frame.url || (frameNode && frameNode.url) || null,
      parentFrameId,
      ownerNodeId,
      available: graph.available !== false,
    });
    node.url = node.url || (frameNode && frameNode.url) || frame.url || null;
    node.ownerNodeId = node.ownerNodeId || ownerNodeId;
    node.nodeCount = nodes.length;
    node.edgeCount = edges.length;
    node.truncated = graph.truncated === true;
    for (const item of nodes) {
      if (!item || item.id == null) continue;
      if (!nodeOwnerFrame.has(String(item.id))) nodeOwnerFrame.set(String(item.id), frame.frameId);
    }
    // roots：优先 roots 数组，其次 frame 节点出边。
    const roots = new Set();
    for (const root of Array.isArray(graph.roots) ? graph.roots : []) {
      if (root != null) roots.add(String(root));
    }
    for (const edge of edges) {
      if (!edge || edge.type !== 'frame') continue;
      if (String(edge.from) === id && edge.to != null && !String(edge.to).startsWith(FRAME_PREFIX)) roots.add(String(edge.to));
      // 父图里的 iframe 元素 → 子帧 frame 节点。
      if (String(edge.to).startsWith(FRAME_PREFIX)) {
        const childFrameId = frameIdOfNodeId(edge.to);
        if (Number.isInteger(childFrameId)) {
          const child = addFrameNode(childFrameId, { parentFrameId: frame.frameId });
          child.ownerNodeId = child.ownerNodeId || String(edge.from);
          add('owns', edge.from, edge.to, 'frame-owner', FRAME_RELATION_CONFIDENCE['frame-owner'], {
            parentFrameId: frame.frameId,
            childFrameId,
          });
        }
      }
    }
    node.roots = roots.size;
    for (const root of roots) {
      add('contains', id, root, 'frame-edge', FRAME_RELATION_CONFIDENCE['frame-edge'], { frameId: frame.frameId });
    }
  }

  // 2) frame 树：frame:<parentId> contains frame:<childId>（frame 自身是关系节点）。
  for (const frame of frames) {
    const parentFrameId = normalizeParentFrameId(frame.parentFrameId, frame.frameId);
    if (!Number.isInteger(parentFrameId)) continue;
    const childId = frameNodeIdOf(frame.frameId);
    const parentId = frameNodeIdOf(parentFrameId);
    addFrameNode(frame.frameId, { url: frame.url, parentFrameId });
    addFrameNode(parentFrameId, {});
    add('contains', parentId, childId, 'parent-frame', FRAME_RELATION_CONFIDENCE['parent-frame'], {
      parentFrameId,
      childFrameId: frame.frameId,
    });
  }

  const frameList = [...frameNodes.values()].map((item) => ({ ...item }));
  // 深度：从 root frame（parentFrameId 缺失或指向未知帧）向下最多 8 层。
  const byFrameId = new Map(frameList.map((item) => [item.frameId, item]));
  for (const item of frameList) {
    let depth = 0;
    let current = item;
    const seen = new Set([item.frameId]);
    while (current && Number.isInteger(current.parentFrameId) && current.parentFrameId !== current.frameId && depth < 8) {
      const parent = byFrameId.get(current.parentFrameId);
      if (!parent || seen.has(parent.frameId)) break;
      seen.add(parent.frameId);
      current = parent;
      depth += 1;
    }
    item.depth = depth;
  }
  const bySource = {};
  for (const relation of relations) bySource[relation.source] = (bySource[relation.source] || 0) + 1;
  const crossFrame = relations.filter((relation) => {
    const left = frameIdOfNodeId(relation.from);
    const right = frameIdOfNodeId(relation.to);
    if (left != null || right != null) return true;
    const leftOwner = nodeOwnerFrame.get(String(relation.from));
    const rightOwner = nodeOwnerFrame.get(String(relation.to));
    return leftOwner != null && rightOwner != null && leftOwner !== rightOwner;
  }).length;
  const linked = frameList.filter((item) => item.frameId !== 0 && Number.isInteger(item.parentFrameId)).length;
  return {
    version: VOM_FRAME_RELATIONS_VERSION,
    frames: frameList,
    nodes: frameList,
    relations,
    stats: {
      frames: frameList.length,
      linked,
      orphan: frameList.filter((item) => item.frameId !== 0 && item.parentFrameId == null).length,
      relations: relations.length,
      crossFrame,
      bySource,
      roots: frameList.reduce((sum, item) => sum + (Number(item.roots) || 0), 0),
      truncated,
    },
    limits: { frames: maxFrames, relations: maxRelations },
  };
}

/** frame 关系图的一行摘要（observe 输出 / 诊断用）。 */
export function summarizeCrossFrameRelations(graph) {
  const stats = (graph && graph.stats) || {};
  const bySource = stats.bySource || {};
  const sources = Object.entries(bySource)
    .sort((a, b) => b[1] - a[1])
    .map(([source, count]) => source + '=' + count)
    .join(' ');
  const parts = [
    'frames=' + (Number(stats.frames) || 0),
    'linked=' + (Number(stats.linked) || 0),
    'relations=' + (Number(stats.relations) || 0),
    'cross-frame=' + (Number(stats.crossFrame) || 0),
  ];
  if (sources) parts.push('by-source[' + sources + ']');
  if (stats.truncated) parts.push('truncated');
  return parts.join(' ');
}
