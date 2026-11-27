// packages/vom/src/frame-vom.ts —— 跨源 iframe 子图（类型化移植，纯函数）。
//
// 源：extension/src/lib/frame-vom.js（差分测试逐字段对拍）。
//
// `observe --frames --vom` 时每个 frame 各自有一份页面图。这里把每帧的图规范化、加上
// `frame:<frameId>` 节点与 `type:"frame"` 边，并做 frame 命名空间：
//   - 节点 id 统一加前缀 `f<frameId>:`，避免不同 frame 的 id 撞车；
//   - 每帧的 roots 通过 `frame:<frameId> → f<frameId>:<root>` 连到一个可引用的根；
//   - 父文档里的 iframe 元素（`frameIndex`）通过 `type:"frame"` 边连到子帧的 `frame:<childId>`
//     节点（父图里也补这个节点，parentId 指向 iframe 元素），这样“iframe 元素 → 子图根”可遍历；
//   - 帧数（默认 16）、每帧节点/边（默认 400/800）都有上限，超限标 truncated。
//
// 主文档子图与各 iframe 子图彼此独立（跨源文档之间没有统一 DOM），调用方按 frameId 取用。
//
// 输入兼容两种图：
//   1) 页面侧原始图（nodes[].key / edges[].from 是页面 key）；
//   2) 已经规范化过的公开图（nodes[].id / parentId）——TS 内容脚本的 richResult.vom.graph。
// 后者会被就地补上 key/parentKey 再走同一条路径，保证两份实现输出一致。

import { buildVomGraph } from './graph.ts';
import type { VomGraphCounts, VomGraphObservedNode, VomGraphPublicNode, VomGraphRawFacts } from './graph.ts';

/** 跨 frame 子图默认上限（与 JS 基线一致）。 */
export const FRAME_VOM_LIMITS: Readonly<{ frames: number; nodes: number; edges: number }> = Object.freeze({
  frames: 16,
  nodes: 400,
  edges: 800,
});

/** 显式 iframe owner 事实（父图 iframe 元素 → 子帧）。 */
export interface FrameIframeOwner {
  readonly frameIndex: number;
  readonly childFrameId: number;
  readonly childUrl?: string | null;
}

/** 单帧输入：页面图 + 已观察节点 + 可选 owner 事实。 */
export interface FrameVomEntry {
  readonly frameId: number;
  readonly url?: string | null;
  readonly parentFrameId?: number | null;
  readonly frameIndex?: number | null;
  readonly graph?: VomGraphRawFacts | null;
  readonly nodes?: readonly VomGraphObservedNode[] | null;
  readonly iframeOwners?: readonly FrameIframeOwner[] | null;
}

/** 子帧清单（用于自动匹配 iframe 元素；隐藏帧被排除）。 */
export interface FrameVomChildFrame {
  readonly frameId: number;
  readonly url?: string | null;
  readonly parentFrameId?: number | null;
  readonly hidden?: boolean;
}

/** buildFrameVomGraphs 选项。 */
export interface FrameVomOptions {
  readonly limits?: { readonly frames?: unknown; readonly nodes?: unknown; readonly edges?: unknown } | null;
  readonly childFrames?: readonly FrameVomChildFrame[] | null;
}

/** 单帧子图（observe --frames --vom 的 frames[].vom）。 */
export interface FrameVomGraph {
  frameId: number;
  url: string;
  available: boolean;
  frameNodeId: string;
  nodes: VomGraphPublicNode[];
  edges: Array<{ type: string; from: string; to: string }>;
  roots: string[];
  counts: VomGraphCounts;
  truncated: boolean;
}

/** iframe 元素 → 子图根 的链接。 */
export interface FrameVomLink {
  fromFrameId: number;
  toFrameId: number;
  ownerId: string;
}

/** 跨 frame 子图汇总。 */
export interface FrameVomSummary {
  count: number;
  nodes: number;
  edges: number;
  truncated: boolean;
  links: FrameVomLink[];
  unlinked: number;
}

/** buildFrameVomGraphs 返回。 */
export interface FrameVomResult {
  graphs: FrameVomGraph[];
  summary: FrameVomSummary;
  limits: { frames: number; nodes: number; edges: number };
}

function limitOf(value: unknown, fallback: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.round(number), max);
}

function namespaceId(frameId: number, id: string): string {
  return 'f' + String(frameId) + ':' + id;
}

function frameNodeFor(frameId: number, entry: FrameVomEntry): VomGraphPublicNode {
  const isMain = frameId === 0;
  return {
    id: 'frame:' + String(frameId),
    ref: null,
    stableRef: null,
    tag: isMain ? 'document' : 'iframe',
    role: isMain ? 'document' : 'frame',
    domId: null,
    parentId: null,
    observed: false,
    frame: true,
    frameId,
    url: entry.url ? String(entry.url).slice(0, 300) : null,
    parentFrameId: Number.isInteger(entry.parentFrameId) ? Number(entry.parentFrameId) : null,
    frameIndex: Number.isInteger(entry.frameIndex) ? Number(entry.frameIndex) : null,
  };
}

function sameFrameUrl(left: unknown, right: unknown): boolean {
  const a = String(left || '');
  const b = String(right || '');
  return a === b || a.split('?')[0] === b.split('?')[0];
}

/** 公开图（nodes[].id）→ 原始图（nodes[].key），供 buildVomGraph 统一处理。 */
function graphForBuild(graph: VomGraphRawFacts | null | undefined): VomGraphRawFacts | null {
  if (!graph) return null;
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : null;
  if (!nodes) return graph;
  let looksPublic = false;
  for (const node of nodes) {
    if (!node) continue;
    const bag = node as unknown as { key?: unknown; vomId?: unknown; id?: unknown };
    if (bag.key === undefined && bag.vomId === undefined && typeof bag.id === 'string') looksPublic = true;
    break;
  }
  if (!looksPublic) return graph;
  return {
    ...graph,
    nodes: nodes.map((node) => {
      const bag = node as unknown as { id?: string; parentId?: string | null; vomId?: string | null };
      return {
        ...(node as unknown as Record<string, unknown>),
        key: bag.id,
        vomId: bag.vomId ?? bag.id,
        parentKey: bag.parentId ?? null,
      };
    }),
  };
}

/**
 * 每帧页面图 → 跨 frame 子图集合 + 汇总（纯函数）。
 *
 * @param entries 每帧输入（frameId/url/parentFrameId/graph/nodes/iframeOwners）
 * @param options limits + childFrames（用于自动匹配 iframe owner；隐藏帧不参与）
 */
export function buildFrameVomGraphs(
  entries: readonly FrameVomEntry[] = [],
  options: FrameVomOptions = {},
): FrameVomResult {
  const maxFrames = limitOf(options.limits && options.limits.frames, FRAME_VOM_LIMITS.frames, 200);
  const perNodes = limitOf(options.limits && options.limits.nodes, FRAME_VOM_LIMITS.nodes, 5000);
  const perEdges = limitOf(options.limits && options.limits.edges, FRAME_VOM_LIMITS.edges, 10000);
  const list = Array.isArray(entries) ? entries : [];
  const childFrames = Array.isArray(options.childFrames)
    ? options.childFrames.filter((frame) => frame && frame.hidden !== true)
    : [];
  const graphs: FrameVomGraph[] = [];
  const links: FrameVomLink[] = [];
  let truncated = false;
  let unlinked = 0;
  let nodes = 0;
  let edges = 0;
  for (const entry of list) {
    if (graphs.length >= maxFrames) {
      truncated = true;
      break;
    }
    if (!entry || !Number.isInteger(entry.frameId)) continue;
    const frameId = entry.frameId;
    const frameNodeId = 'frame:' + String(frameId);
    const frameNode = frameNodeFor(frameId, entry);
    const built = buildVomGraph({
      graph: graphForBuild(entry.graph),
      nodes: entry.nodes ?? [],
      limits: { nodes: perNodes, edges: perEdges },
    });
    if (!built.available) {
      graphs.push({
        frameId,
        url: entry.url || '',
        available: false,
        frameNodeId,
        nodes: [frameNode],
        edges: [],
        roots: [frameNodeId],
        counts: { nodes: 1, edges: 0, byType: {} },
        truncated: false,
      });
      nodes += 1;
      continue;
    }
    const payload = built.payload;
    const idMap = new Map<string, string>();
    const mappedNodes: VomGraphPublicNode[] = payload.nodes.map((node) => {
      const id = namespaceId(frameId, node.id);
      idMap.set(node.id, id);
      const ancestorIds = Array.isArray(node.ancestorIds) ? node.ancestorIds : [];
      return {
        ...node,
        id,
        parentId: node.parentId ? namespaceId(frameId, node.parentId) : null,
        ancestorIds: ancestorIds.map((ancestor) => namespaceId(frameId, ancestor)),
      };
    });
    const mappedEdges: Array<{ type: string; from: string; to: string }> = payload.edges.map((edge) => ({
      type: edge.type,
      from: idMap.get(edge.from) || 'f' + String(frameId) + ':?',
      to: idMap.get(edge.to) || 'f' + String(frameId) + ':?',
    }));
    const roots = payload.roots.map((root) => idMap.get(root)).filter((root): root is string => Boolean(root));
    for (const root of roots) mappedEdges.push({ type: 'frame', from: frameNodeId, to: root });
    const graphNodes: VomGraphPublicNode[] = [frameNode, ...mappedNodes];
    const byType: Record<string, number> = { ...(payload.counts && payload.counts.byType ? payload.counts.byType : {}) };
    byType.frame = roots.length;

    // iframe 元素 → 子帧根：优先用显式 iframeOwners，否则按父图里 iframe 节点的 srcUrl
    // 与子帧 URL 匹配（嵌套 iframe 同样适用，不依赖 frame-meta 的注入顺序）。
    const explicitOwners = Array.isArray(entry.iframeOwners) ? entry.iframeOwners : [];
    const autoOwners: FrameIframeOwner[] = [];
    if (!explicitOwners.length && childFrames.length) {
      const usedIndexes = new Set<number>();
      for (const child of childFrames) {
        const parentId = Number.isInteger(child.parentFrameId) ? Number(child.parentFrameId) : 0;
        if (parentId !== frameId) continue;
        if (Number(child.frameId) === frameId) continue;
        const candidates = mappedNodes.filter((node) => node.tag === 'iframe' && node.frameIndex != null
          && !usedIndexes.has(Number(node.frameIndex))
          && (sameFrameUrl(node.srcUrl, child.url) || !node.srcUrl));
        const node = candidates[0];
        if (!node) continue;
        usedIndexes.add(Number(node.frameIndex));
        autoOwners.push({ frameIndex: Number(node.frameIndex), childFrameId: child.frameId, childUrl: child.url });
      }
    }
    for (const owner of explicitOwners.concat(autoOwners)) {
      if (!owner || !Number.isInteger(owner.frameIndex) || !Number.isInteger(owner.childFrameId)) continue;
      const ownerNode = mappedNodes.find((node) => node.frameIndex === owner.frameIndex && node.tag === 'iframe');
      if (!ownerNode) {
        unlinked += 1;
        continue;
      }
      const childFrameId = owner.childFrameId;
      const childFrameNodeId = 'frame:' + String(childFrameId);
      if (!graphNodes.some((node) => node.id === childFrameNodeId)) {
        graphNodes.push({
          id: childFrameNodeId,
          ref: null,
          stableRef: null,
          tag: 'iframe',
          role: 'frame',
          domId: null,
          parentId: ownerNode.id,
          observed: false,
          frame: true,
          frameId: childFrameId,
          url: owner.childUrl ? String(owner.childUrl).slice(0, 300) : null,
          parentFrameId: frameId,
          frameIndex: null,
          ancestorIds: [ownerNode.id, ...(ownerNode.ancestorIds || [])],
        });
      }
      const edge = { type: 'frame', from: ownerNode.id, to: childFrameNodeId };
      if (!mappedEdges.some((item) => item.type === edge.type && item.from === edge.from && item.to === edge.to)) {
        mappedEdges.push(edge);
      }
      byType.frame += 1;
      links.push({ fromFrameId: frameId, toFrameId: childFrameId, ownerId: ownerNode.id });
    }

    graphs.push({
      frameId,
      url: entry.url || '',
      available: true,
      frameNodeId,
      nodes: graphNodes,
      edges: mappedEdges,
      roots: [frameNodeId],
      counts: { nodes: graphNodes.length, edges: mappedEdges.length, byType },
      truncated: payload.truncated === true,
    });
    nodes += graphNodes.length;
    edges += mappedEdges.length;
    if (payload.truncated === true) truncated = true;
  }
  return {
    graphs,
    summary: { count: graphs.length, nodes, edges, truncated, links, unlinked },
    limits: { frames: maxFrames, nodes: perNodes, edges: perEdges },
  };
}
