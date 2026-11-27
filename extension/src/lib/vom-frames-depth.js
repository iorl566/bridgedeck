// lib/vom-frames-depth.js —— 跨帧 VOM 子图的深度报告：归属链 / frame 边 / 缺口（纯函数）。
//
// `observe --frames --vom` 会给每个 frame 挂一份规范化子图（lib/frame-vom.js）：
//   {frameId, url, available, frameNodeId, nodes, edges, roots, counts, truncated}
// 本模块把它聚合成“frame 树 + 归属边 + 覆盖缺口”的报告：
//   - chains：frameId → 父 frameId → 0 的祖链（cycle 检测），回答“这个子图属于哪条 iframe 链”；
//   - links：父图 iframe 元素（ownerId）→ 子帧 graph 节点（frame:<childId>）的归属边；
//   - gaps：hidden frame / 无子图 / 子帧没有 frame 边关联 / 父帧缺失 / 截断，全部结构化；
//   - stats：帧数、有图帧数、节点/边/归属边、最大深度、是否截断。
// 缺证据时只标缺口，不补造 frame 边。

export const VOM_FRAMES_DEPTH_VERSION = 1;

export const FRAME_DEPTH_LIMITS = Object.freeze({ frames: 32, chain: 8, gaps: 32, nodes: 1000 });

function limitOf(value, fallback, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.floor(number), max);
}

function frameIdOf(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function graphOf(frame) {
  if (!frame || typeof frame !== 'object') return null;
  const vom = frame.vom && typeof frame.vom === 'object' ? frame.vom : null;
  if (!vom) return null;
  return {
    available: vom.available === true,
    frameNodeId: vom.frameNodeId ? String(vom.frameNodeId) : 'frame:' + frameIdOf(frame.frameId),
    nodes: Array.isArray(vom.nodes) ? vom.nodes : [],
    edges: Array.isArray(vom.edges) ? vom.edges : [],
    counts: vom.counts && typeof vom.counts === 'object'
      ? { nodes: Number(vom.counts.nodes) || 0, edges: Number(vom.counts.edges) || 0, byType: vom.counts.byType && typeof vom.counts.byType === 'object' ? { ...vom.counts.byType } : {} }
      : { nodes: 0, edges: 0, byType: {} },
    truncated: vom.truncated === true,
  };
}

/** 父帧链：frameId → ... → 0；遇环标记 cycle。 */
export function frameChainOf(frameId, parentById, options = {}) {
  const maxDepth = limitOf(options.maxChain, FRAME_DEPTH_LIMITS.chain, 64);
  const start = frameIdOf(frameId);
  const path = [];
  if (start === null) return { frameId: start, path, depth: 0, cycle: false, missingParent: false };
  const visited = new Set([start]);
  let current = start;
  path.push(current);
  let cycle = false;
  let missingParent = false;
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const parent = parentById.get(current);
    if (parent === null || parent === undefined) {
      if (current !== 0) missingParent = true;
      break;
    }
    if (visited.has(parent)) { cycle = true; break; }
    visited.add(parent);
    path.push(parent);
    current = parent;
    if (parent === 0) break;
  }
  return { frameId: start, path, depth: path.length - 1, cycle, missingParent };
}

/**
 * 构建跨帧深度报告。
 * @param {{frames?:object[], vomFrames?:object|null, frameGaps?:object|null, limits?:object}} [input]
 */
export function buildFrameDepthReport(input = {}) {
  const limits = { ...FRAME_DEPTH_LIMITS, ...(input.limits && typeof input.limits === 'object' ? input.limits : {}) };
  const maxFrames = limitOf(limits.frames, FRAME_DEPTH_LIMITS.frames, 200);
  const maxGaps = limitOf(limits.gaps, FRAME_DEPTH_LIMITS.gaps, 200);
  const frames = (Array.isArray(input.frames) ? input.frames : []).filter((frame) => frame && frameIdOf(frame.frameId) !== null);
  const parentById = new Map();
  for (const frame of frames) parentById.set(frameIdOf(frame.frameId), frameIdOf(frame.parentFrameId));
  const gaps = [];
  const pushGap = (item) => {
    if (gaps.length < maxGaps) gaps.push(item);
  };
  const links = [];
  const entries = [];
  let nodes = 0;
  let edges = 0;
  let graphed = 0;
  let hidden = 0;
  let unlinked = 0;
  let truncated = false;
  for (const frame of frames.slice(0, maxFrames)) {
    const frameId = frameIdOf(frame.frameId);
    if (frameId === null) continue;
    const graph = graphOf(frame);
    if (frame.hidden === true) hidden += 1;
    if (!graph) {
      pushGap({ frameId, reason: frame.hidden === true ? 'hidden-frame' : 'no-graph', evidence: { url: frame.url ? String(frame.url).slice(0, 200) : '' } });
      entries.push({ frameId, parentFrameId: frameIdOf(frame.parentFrameId), url: frame.url || '', hidden: frame.hidden === true, graph: null, chain: frameChainOf(frameId, parentById, { maxChain: limits.chain }) });
      continue;
    }
    if (!graph.available) {
      pushGap({ frameId, reason: 'graph-unavailable', evidence: { nodes: graph.nodes.length, edges: graph.edges.length } });
    } else {
      graphed += 1;
    }
    nodes += graph.counts.nodes;
    edges += graph.counts.edges;
    if (graph.truncated) truncated = true;
    for (const edge of graph.edges) {
      if (!edge || edge.type !== 'frame') continue;
      const target = String(edge.to || '');
      const match = /^frame:(-?\d+)$/.exec(target);
      if (!match) continue;
      const childFrameId = Number(match[1]);
      links.push({ fromFrameId: frameId, toFrameId: childFrameId, ownerId: String(edge.from || '') });
    }
    entries.push({
      frameId,
      parentFrameId: frameIdOf(frame.parentFrameId),
      url: frame.url || '',
      hidden: frame.hidden === true,
      graph: {
        available: graph.available,
        frameNodeId: graph.frameNodeId,
        nodes: graph.counts.nodes,
        edges: graph.counts.edges,
        byType: graph.counts.byType,
        truncated: graph.truncated,
      },
      chain: frameChainOf(frameId, parentById, { maxChain: limits.chain }),
    });
  }
  if (frames.length > maxFrames) truncated = true;
  // 子帧归属核对：每个非根 frame 应该有一条父图 frame 边；没有就记 unlinked。
  const linkedChildren = new Set(links.map((link) => link.toFrameId));
  for (const frame of frames) {
    const frameId = frameIdOf(frame.frameId);
    const parentFrameId = frameIdOf(frame.parentFrameId);
    if (frameId === null || frameId === 0 || parentFrameId === null || parentFrameId === undefined) continue;
    if (linkedChildren.has(frameId)) continue;
    unlinked += 1;
    pushGap({
      frameId,
      reason: frame.hidden === true ? 'hidden-frame' : 'frame-edge-missing',
      evidence: { parentFrameId, url: frame.url ? String(frame.url).slice(0, 200) : '' },
    });
  }
  for (const entry of entries) {
    if (entry.chain && entry.chain.cycle) pushGap({ frameId: entry.frameId, reason: 'frame-chain-cycle', evidence: { chain: entry.chain.path } });
    if (entry.chain && entry.chain.missingParent) pushGap({ frameId: entry.frameId, reason: 'parent-frame-missing', evidence: { chain: entry.chain.path } });
  }
  const maxDepth = entries.reduce((max, entry) => Math.max(max, entry.chain ? entry.chain.depth : 0), 0);
  const described = entries.map((entry) => {
    const link = links.find((item) => item.toFrameId === entry.frameId) || null;
    return {
      ...entry,
      ...(link ? { owner: { fromFrameId: link.fromFrameId, ownerId: link.ownerId } } : {}),
    };
  });
  return {
    version: VOM_FRAMES_DEPTH_VERSION,
    available: entries.length > 0,
    frames: described,
    links,
    gaps,
    stats: {
      frames: entries.length,
      graphed,
      nodes,
      edges,
      links: links.length,
      unlinked,
      hidden,
      maxDepth,
      truncated,
    },
    summary: input.vomFrames && typeof input.vomFrames === 'object'
      ? {
        count: Number(input.vomFrames.count) || 0,
        nodes: Number(input.vomFrames.nodes) || 0,
        edges: Number(input.vomFrames.edges) || 0,
        links: Array.isArray(input.vomFrames.links) ? input.vomFrames.links.length : 0,
        unlinked: Number(input.vomFrames.unlinked) || 0,
        truncated: input.vomFrames.truncated === true,
      }
      : null,
    gapsFromUpstream: input.frameGaps && typeof input.frameGaps === 'object' ? input.frameGaps : null,
    limits: { frames: maxFrames, gaps: maxGaps, chain: limitOf(limits.chain, FRAME_DEPTH_LIMITS.chain, 64) },
  };
}

/** JSON 安全摘要（observe-frames 输出的 vomFrameDepth）。 */
export function summarizeFrameDepth(report, options = {}) {
  if (!report || typeof report !== 'object') {
    return {
      version: VOM_FRAMES_DEPTH_VERSION,
      available: false,
      counts: { frames: 0, graphed: 0, links: 0, gaps: 0 },
      frames: [],
      links: [],
      gaps: [],
      stats: {},
    };
  }
  const maxFrames = limitOf(options.frames, 8, 64);
  const maxGaps = limitOf(options.gaps, 8, 64);
  return {
    version: report.version || VOM_FRAMES_DEPTH_VERSION,
    available: report.available === true,
    counts: {
      frames: Number(report.stats && report.stats.frames) || 0,
      graphed: Number(report.stats && report.stats.graphed) || 0,
      links: Number(report.stats && report.stats.links) || 0,
      gaps: Array.isArray(report.gaps) ? report.gaps.length : 0,
      unlinked: Number(report.stats && report.stats.unlinked) || 0,
      hidden: Number(report.stats && report.stats.hidden) || 0,
    },
    stats: { ...(report.stats || {}) },
    frames: (Array.isArray(report.frames) ? report.frames : []).slice(0, maxFrames).map((entry) => ({
      frameId: entry.frameId,
      parentFrameId: entry.parentFrameId,
      url: entry.url,
      hidden: entry.hidden === true,
      graph: entry.graph,
      chain: entry.chain ? entry.chain.path : [],
      ...(entry.owner ? { owner: entry.owner } : {}),
    })),
    links: (Array.isArray(report.links) ? report.links : []).slice(0, maxFrames * 2),
    gaps: (Array.isArray(report.gaps) ? report.gaps : []).slice(0, maxGaps),
    ...(report.gapsFromUpstream ? { gapsFromUpstream: report.gapsFromUpstream } : {}),
    truncated: Boolean(report.stats && report.stats.truncated),
  };
}

/** 一行诊断文本（observe-frames 的 vomFrameDepthText）。 */
export function describeFrameDepth(summary) {
  if (!summary || typeof summary !== 'object') return '';
  const counts = summary.counts || {};
  const parts = ['frames=' + (counts.frames || 0) + ' graphed=' + (counts.graphed || 0) + ' links=' + (counts.links || 0)];
  if (Number(counts.gaps) > 0) parts.push('gaps=' + Number(counts.gaps));
  if (Number(counts.unlinked) > 0) parts.push('unlinked=' + Number(counts.unlinked));
  if (Number(counts.hidden) > 0) parts.push('hidden=' + Number(counts.hidden));
  if (summary.truncated) parts.push('truncated');
  return parts.join(' ');
}

export function frameDepthVersion() {
  return VOM_FRAMES_DEPTH_VERSION;
}
