// packages/vom/src/frame-relations.ts —— 跨 frame 关系图（类型化移植，纯函数）。
//
// 源：extension/src/lib/vom-frame-relations.js（差分测试对拍，逐字段相等）。
//
// `observe --frames --vom` 时每个 frame 各自有一份页面图（lib/frame-vom.js 已做命名空间与
// frame 节点）。本模块把这些子图拼成一张“frame 作为节点”的关系层：
//   - frame:<frameId> 是显式节点（role=document / frame），参与 contains/owns 关系；
//   - frame:<frameId> --contains(frame-edge)--> 该 frame 的 roots（真实元素）；
//   - 父帧里的 iframe 元素 --owns(frame-owner)--> 子帧 frame:<childId>；
//   - frame:<parentId> --contains(parent-frame)--> frame:<childId>（frame 树本身也是关系）。
//
// 输入容忍三种形态：{graphs} 包装 / frame 列表（子图挂 graph 或 vom）/ 直接子图数组。
// 输出是纯 JSON（可跨 executeScript 边界），每条关系带 confidence/source，多来源合并取最大置信度。

import type {
  CollectedFrameGraph,
  FrameGraphSourceInput,
  FrameNodeRecord,
  FrameRelationRecord,
  FrameRelationsInput,
  FrameRelationsOptions,
  FrameRelationsReport,
  FrameRelationsStats,
  FrameRelationSource,
  VomGraphEdgeFacts,
  VomGraphFacts,
  VomGraphNodeFacts,
} from './relation-types.ts';

/** 跨 frame 关系图版本。 */
export const VOM_FRAME_RELATIONS_VERSION = 1;

/** 跨 frame 关系默认上限。 */
export const FRAME_RELATION_LIMITS: Readonly<{ frames: number; relations: number }> = Object.freeze({
  frames: 16,
  relations: 400,
});

/** 跨 frame 关系的来源 → 置信度。frame 边是显式结构，置信度高于 DOM 推导。 */
export const FRAME_RELATION_CONFIDENCE: Readonly<Record<FrameRelationSource, number>> = Object.freeze({
  'frame-edge': 0.95,
  'frame-owner': 0.9,
  'parent-frame': 0.9,
});

const FRAME_PREFIX = 'frame:';

/** 上限归一：非有限/非正回落到 fallback，向上取整后夹到 max。 */
function limitOf(value: unknown, fallback: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.floor(number), max);
}

/** 置信度归一：非有限为 0，夹到 [0,1] 并保留两位小数。 */
function confidenceOf(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(1, Math.max(0, Math.round(number * 100) / 100));
}

/** 数组归一（页面事实可能不是数组）。 */
function arrayOf<T>(value: unknown): readonly T[] {
  return Array.isArray(value) ? (value as readonly T[]) : [];
}

/** frame 节点 id（与 lib/frame-vom.js 的命名保持一致）。 */
export function frameNodeIdOf(frameId: unknown): string {
  const id = Number(frameId);
  return FRAME_PREFIX + (Number.isFinite(id) ? id : String(frameId));
}

/** frame 节点 id → frameId（数字串转 number，非数字保留字符串，非 frame 前缀为 null）。 */
function frameIdOfNodeId(id: unknown): number | string | null {
  const text = String(id || '');
  if (!text.startsWith(FRAME_PREFIX)) return null;
  const value = text.slice(FRAME_PREFIX.length);
  return /^-?\d+$/.test(value) ? Number(value) : value;
}

/** Chrome 用 -1 表示主 frame 没有父帧；负值/自身都归一成 null（根帧）。 */
function normalizeParentFrameId(value: unknown, frameId: number | null = null): number | null {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) return null;
  if (frameId != null && number === Number(frameId)) return null;
  return number;
}

/** 从列表项里挑子图：graph 优先，其次 vom，最后“本身就是图”的对象。 */
function pickGraph(item: FrameGraphSourceInput | null | undefined): VomGraphFacts | null {
  if (!item || typeof item !== 'object') return null;
  if (item.graph && typeof item.graph === 'object') return item.graph;
  if (item.vom && typeof item.vom === 'object') return item.vom;
  if (Array.isArray(item.nodes) || Array.isArray(item.edges)) {
    return item as VomGraphFacts;
  }
  return null;
}

/** 把三种输入形态归一成 [{frameId, url, parentFrameId, graph}]；保持输入顺序。 */
export function collectFrameGraphs(input: FrameRelationsInput): CollectedFrameGraph[] {
  if (!input) return [];
  let array: readonly unknown[] | null = null;
  if (Array.isArray(input)) array = input;
  else if (typeof input === 'object' && Array.isArray((input as { graphs?: unknown }).graphs)) {
    array = (input as { graphs: readonly unknown[] }).graphs;
  }
  if (!array) return [];
  const out: CollectedFrameGraph[] = [];
  for (const raw of array) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as FrameGraphSourceInput;
    const graph = pickGraph(item);
    if (!graph) continue;
    const declared = Number(item.frameId);
    const resolved = Number.isFinite(declared) ? declared : frameIdOfNodeId(item.frameNodeId);
    if (typeof resolved !== 'number' || !Number.isInteger(resolved)) continue;
    out.push({
      frameId: resolved,
      url: item.url != null ? String(item.url).slice(0, 300) : null,
      parentFrameId: Number.isInteger(item.parentFrameId) ? (item.parentFrameId as number) : null,
      graph,
    });
  }
  return out;
}

/** 构建一条跨 frame 关系记录（不合并）。 */
function relationRecord(
  type: 'contains' | 'owns',
  from: string,
  to: string,
  source: FrameRelationSource,
  confidence: unknown,
  extra: Record<string, unknown> | undefined,
): FrameRelationRecord {
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
 * 把多份 frame 子图拼成跨 frame 关系图。
 * @param input frame 列表 / {graphs} 包装 / 直接子图数组
 * @param options limits.frames / limits.relations 上限
 */
export function buildCrossFrameRelations(
  input: FrameRelationsInput = {},
  options: FrameRelationsOptions = {},
): FrameRelationsReport {
  const collected = collectFrameGraphs(input);
  const maxFrames = limitOf(options.limits && options.limits.frames, FRAME_RELATION_LIMITS.frames, 200);
  const maxRelations = limitOf(options.limits && options.limits.relations, FRAME_RELATION_LIMITS.relations, 5000);
  const frames = collected.slice(0, maxFrames);
  const truncated = collected.length > frames.length;
  const relations: FrameRelationRecord[] = [];
  const index = new Map<string, FrameRelationRecord>();
  const frameNodes = new Map<string, FrameNodeRecord>();
  const nodeOwnerFrame = new Map<string, number>();

  const add = (
    type: 'contains' | 'owns',
    from: unknown,
    to: unknown,
    source: FrameRelationSource,
    confidence: unknown,
    extra?: Record<string, unknown>,
  ): FrameRelationRecord | null => {
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

  const addFrameNode = (
    frameId: number,
    info: {
      url?: unknown;
      parentFrameId?: unknown;
      ownerNodeId?: unknown;
      available?: unknown;
    } = {},
  ): FrameNodeRecord => {
    const id = frameNodeIdOf(frameId);
    const existing = frameNodes.get(id);
    if (!existing) {
      const record: FrameNodeRecord = {
        id,
        frameId,
        role: frameId === 0 ? 'document' : 'frame',
        url: (info.url || null) as string | null,
        parentFrameId: Number.isInteger(info.parentFrameId) ? (info.parentFrameId as number) : null,
        ownerNodeId: (info.ownerNodeId || null) as string | null,
        available: info.available === true,
        placeholder: info.available !== true,
      };
      frameNodes.set(id, record);
      return record;
    }
    if (info.available === true) {
      existing.available = true;
      existing.placeholder = false;
      if (!existing.url && info.url) existing.url = String(info.url);
      if (!Number.isInteger(existing.parentFrameId) && Number.isInteger(info.parentFrameId)) {
        existing.parentFrameId = info.parentFrameId as number;
      }
    }
    return existing;
  };

  // 1) 每帧：frame 节点、roots 的 contains 边、父图里 iframe 元素→子帧节点的 owns 边。
  for (const frame of frames) {
    const graph = frame.graph;
    const nodes = arrayOf<VomGraphNodeFacts>(graph.nodes);
    const edges = arrayOf<VomGraphEdgeFacts>(graph.edges);
    const id = frameNodeIdOf(frame.frameId);
    const frameNode = nodes.find((node) => node && (node.id as unknown) === id) || null;
    const parentFrameId = frame.parentFrameId != null
      ? normalizeParentFrameId(frame.parentFrameId, frame.frameId)
      : normalizeParentFrameId(frameNode && frameNode.parentId, frame.frameId);
    const ownerNodeId = (frameNode && frameNode.parentId) || null;
    const node = addFrameNode(frame.frameId, {
      url: frame.url || (frameNode && frameNode.url) || null,
      parentFrameId,
      ownerNodeId,
      available: graph.available !== false,
    });
    node.url = (node.url || (frameNode && frameNode.url) || frame.url || null) as string | null;
    node.ownerNodeId = (node.ownerNodeId || ownerNodeId) as string | null;
    node.nodeCount = nodes.length;
    node.edgeCount = edges.length;
    node.truncated = graph.truncated === true;
    for (const item of nodes) {
      if (!item || item.id == null) continue;
      if (!nodeOwnerFrame.has(String(item.id))) nodeOwnerFrame.set(String(item.id), frame.frameId);
    }
    // roots：优先 roots 数组，其次 frame 节点出边。
    const roots = new Set<string>();
    for (const root of arrayOf<unknown>(graph.roots)) {
      if (root != null) roots.add(String(root));
    }
    for (const edge of edges) {
      if (!edge || edge.type !== 'frame') continue;
      if (String(edge.from) === id && edge.to != null && !String(edge.to).startsWith(FRAME_PREFIX)) {
        roots.add(String(edge.to));
      }
      // 父图里的 iframe 元素 → 子帧 frame 节点。
      if (String(edge.to).startsWith(FRAME_PREFIX)) {
        const childFrameId = frameIdOfNodeId(edge.to);
        if (typeof childFrameId === 'number' && Number.isInteger(childFrameId)) {
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
    if (parentFrameId == null) continue;
    const childId = frameNodeIdOf(frame.frameId);
    const parentId = frameNodeIdOf(parentFrameId);
    addFrameNode(frame.frameId, { url: frame.url, parentFrameId });
    addFrameNode(parentFrameId, {});
    add('contains', parentId, childId, 'parent-frame', FRAME_RELATION_CONFIDENCE['parent-frame'], {
      parentFrameId,
      childFrameId: frame.frameId,
    });
  }

  const frameList: FrameNodeRecord[] = [...frameNodes.values()].map((item) => ({ ...item }));
  // 深度：从 root frame（parentFrameId 缺失或指向未知帧）向下最多 8 层。
  const byFrameId = new Map<number, FrameNodeRecord>(frameList.map((item) => [item.frameId, item]));
  for (const item of frameList) {
    let depth = 0;
    let current: FrameNodeRecord | undefined = item;
    const seen = new Set<number>([item.frameId]);
    while (current && Number.isInteger(current.parentFrameId)
      && current.parentFrameId !== current.frameId && depth < 8) {
      const parentFrameId = current.parentFrameId;
      if (parentFrameId == null) break;
      const parent = byFrameId.get(parentFrameId);
      if (!parent || seen.has(parent.frameId)) break;
      seen.add(parent.frameId);
      current = parent;
      depth += 1;
    }
    item.depth = depth;
  }
  const bySource: Record<string, number> = {};
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
  const stats: FrameRelationsStats = {
    frames: frameList.length,
    linked,
    orphan: frameList.filter((item) => item.frameId !== 0 && item.parentFrameId == null).length,
    relations: relations.length,
    crossFrame,
    bySource,
    roots: frameList.reduce((sum, item) => sum + (Number(item.roots) || 0), 0),
    truncated,
  };
  return {
    version: VOM_FRAME_RELATIONS_VERSION,
    frames: frameList,
    nodes: frameList,
    relations,
    stats,
    limits: { frames: maxFrames, relations: maxRelations },
  };
}

/** 跨 frame 关系图的一行摘要（observe 输出 / 诊断用）。 */
export function summarizeCrossFrameRelations(
  graph: { readonly stats?: Partial<FrameRelationsStats> | null } | null | undefined,
): string {
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
