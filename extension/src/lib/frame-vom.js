// lib/frame-vom.js —— 跨源 iframe 子图（纯函数）。
//
// `observe --frames --vom` 时每个 frame 各自有一份页面图（page-lib 在该 frame 内收集）。
// 这里把每帧的图规范化、加上 `frame:<frameId>` 节点与 `type:"frame"` 边，并做 frame 命名空间：
//   - 节点 id 统一加前缀 `f<frameId>:`，避免不同 frame 的 `@eN` 撞车；
//   - 每帧的 roots 通过 `frame:<frameId> → f<frameId>:<root>` 连到一个可引用的根；
//   - 父文档里的 iframe 元素（`frameIndex`）通过 `type:"frame"` 边连到子帧的 `frame:<childId>`
//     节点（父图里也补这个节点，parentId 指向 iframe 元素），这样“iframe 元素 → 子图根”可遍历；
//   - 帧数（默认 16）、每帧节点/边（默认 400/800）都有上限，超限标 truncated。
//
// 主文档子图与各 iframe 子图彼此独立（跨源文档之间没有统一 DOM），调用方按 frameId 取用。

import { buildVomGraph } from './vom-graph.js';

export const FRAME_VOM_LIMITS = Object.freeze({ frames: 16, nodes: 400, edges: 800 });

function limitOf(value, fallback, max) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.min(Math.round(num), max);
}

function namespaceId(frameId, id) {
  return 'f' + frameId + ':' + id;
}

function frameNodeFor(frameId, entry) {
  const isMain = frameId === 0;
  return {
    id: 'frame:' + frameId,
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
    parentFrameId: Number.isInteger(entry.parentFrameId) ? entry.parentFrameId : null,
    frameIndex: Number.isInteger(entry.frameIndex) ? entry.frameIndex : null,
  };
}

function sameFrameUrl(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  return left === right || left.split('?')[0] === right.split('?')[0];
}

/**
 * @param {Array<{frameId:number,url?:string,parentFrameId?:number,frameIndex?:number,graph?:object|null,nodes?:object[]|null,iframeOwners?:Array<{frameIndex:number,childFrameId:number,childUrl?:string}>}>} entries
 * @param {{limits?:{frames?:number,nodes?:number,edges?:number},childFrames?:Array<{frameId:number,url?:string,parentFrameId?:number,hidden?:boolean}>}} options
 * @returns {{graphs:object[], summary:{count:number,nodes:number,edges:number,truncated:boolean,links:object[],unlinked:number}, limits:object}}
 */
export function buildFrameVomGraphs(entries = [], options = {}) {
  const maxFrames = limitOf(options.limits && options.limits.frames, FRAME_VOM_LIMITS.frames, 200);
  const perNodes = limitOf(options.limits && options.limits.nodes, FRAME_VOM_LIMITS.nodes, 5000);
  const perEdges = limitOf(options.limits && options.limits.edges, FRAME_VOM_LIMITS.edges, 10000);
  const list = Array.isArray(entries) ? entries : [];
  const childFrames = Array.isArray(options.childFrames) ? options.childFrames.filter((frame) => frame && frame.hidden !== true) : [];
  const graphs = [];
  const links = [];
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
    const frameNodeId = 'frame:' + frameId;
    const frameNode = frameNodeFor(frameId, entry);
    const built = buildVomGraph({
      graph: entry.graph || null,
      nodes: entry.nodes || [],
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
    const idMap = new Map();
    const mappedNodes = payload.nodes.map((node) => {
      const id = namespaceId(frameId, node.id);
      idMap.set(node.id, id);
      return {
        ...node,
        id,
        parentId: node.parentId ? namespaceId(frameId, node.parentId) : null,
        ancestorIds: (node.ancestorIds || []).map((ancestor) => namespaceId(frameId, ancestor)),
      };
    });
    const mappedEdges = payload.edges.map((edge) => ({
      type: edge.type,
      from: idMap.get(edge.from) || ('f' + frameId + ':?'),
      to: idMap.get(edge.to) || ('f' + frameId + ':?'),
    }));
    const roots = payload.roots.map((root) => idMap.get(root)).filter(Boolean);
    for (const root of roots) mappedEdges.push({ type: 'frame', from: frameNodeId, to: root });
    const graphNodes = [frameNode, ...mappedNodes];
    const byType = { ...(payload.counts && payload.counts.byType ? payload.counts.byType : {}) };
    byType.frame = roots.length;

    // iframe 元素 → 子帧根：优先用显式 iframeOwners，否则按父图里 iframe 节点的 srcUrl
    // 与子帧 URL 匹配（嵌套 iframe 同样适用，不依赖 frame-meta 的注入顺序）。
    const explicitOwners = Array.isArray(entry.iframeOwners) ? entry.iframeOwners : [];
    const autoOwners = [];
    if (!explicitOwners.length && childFrames.length) {
      const usedIndexes = new Set();
      for (const child of childFrames) {
        const parentId = Number.isInteger(child.parentFrameId) ? child.parentFrameId : 0;
        if (parentId !== frameId) continue;
        if (Number(child.frameId) === frameId) continue;
        const candidates = mappedNodes.filter((node) => node.tag === 'iframe' && node.frameIndex != null
          && !usedIndexes.has(node.frameIndex)
          && (sameFrameUrl(node.srcUrl, child.url) || !node.srcUrl));
        const node = candidates[0];
        if (!node) continue;
        usedIndexes.add(node.frameIndex);
        autoOwners.push({ frameIndex: node.frameIndex, childFrameId: child.frameId, childUrl: child.url });
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
      const childFrameNodeId = 'frame:' + childFrameId;
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
