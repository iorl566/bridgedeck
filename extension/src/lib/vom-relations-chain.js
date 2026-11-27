// lib/vom-relations-chain.js —— 关系图“全链”解析：containment / ownership / labels / controls / describes。
//
// 输入是 lib/vom-relations.js 已产出的关系图（`graph.relations`：{type, from, to, confidence, source}），
// 本模块不再推导新关系，而是把“点-边”聚合成 Agent 可直接用的**链**：
//   - contains 链：节点 → 祖先（DOM 包含），供“这个按钮在哪个表单/landmark 下”；
//   - ownership 链：aria-owns / form-anchor / composite-owner 与 contains 混合成的归属路径，
//     回答“这个 option 归哪个 listbox、这个 input 归哪个 form”；
//   - labels 链：aria-labelledby / label-for 的可读标签链（含链式深度）；
//   - controls 链：aria-controls（tab → panel 等）正向受控元素；
//   - describes 链：aria-describedby / 错误消息 → 被描述节点；
//   - invalidates 链：aria-errormessage → 无效控件。
// 另提供两个诊断能力：
//   - findRelationPaths：任意两节点之间的关系路径（双向遍历，含方向标注）；
//   - checkRelationChainIntegrity：悬空端点 / 重复边 / 未知类型 / 自环 / 环，全部结构化报告。
//
// 纯函数，不读 DOM。深度/条数都有上限并标 truncated，绝不因缺证据而补造边。

export const VOM_RELATION_CHAIN_VERSION = 1;

/** 支持成链的关系类型；顺序即输出字段顺序。 */
export const CHAIN_TYPES = Object.freeze(['contains', 'owns', 'labels', 'controls', 'describes', 'invalidates']);

/** 允许 from === to 的关系（自身属性）。 */
export const CHAIN_SELF_TYPES = Object.freeze(['describes', 'invalidates']);

/** 每种关系类型“面向节点”的默认遍历方向：in = 沿指向该节点的边反向追。 */
export const CHAIN_DIRECTIONS = Object.freeze({
  contains: 'in',
  owns: 'in',
  labels: 'in',
  controls: 'out',
  describes: 'in',
  invalidates: 'in',
});

export const CHAIN_LIMITS = Object.freeze({
  links: 2000,
  nodes: 200,
  depth: 4,
  paths: 8,
  pathDepth: 5,
  steps: 32,
  cycles: 20,
  dangling: 40,
});

function limitOf(value, fallback, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.floor(number), max);
}

function idOf(value) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text ? text : null;
}

function confidenceOf(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(1, Math.max(0, Math.round(number * 1000) / 1000));
}

function typeOf(value) {
  const text = String(value == null ? '' : value).trim();
  return text;
}

function nodeMetaOf(nodes) {
  const map = new Map();
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!node || typeof node !== 'object') continue;
    const id = idOf(node.id != null ? node.id : (node.ref || node.stableRef));
    if (!id) continue;
    map.set(id, {
      id,
      role: node.role == null ? null : String(node.role),
      name: node.name == null ? null : String(node.name).slice(0, 80),
      tag: node.tag == null ? null : String(node.tag).toLowerCase(),
    });
  }
  return map;
}

/**
 * 单条关系边归一化；缺端点/未知类型直接丢弃（不补边）。
 * @returns {{type:string, from:string, to:string, confidence:number, source:string|null, sources:string[], depth:number|null, chain:string[]|null}|null}
 */
export function normalizeRelationLink(relation) {
  if (!relation || typeof relation !== 'object') return null;
  const type = typeOf(relation.type);
  const from = idOf(relation.from);
  const to = idOf(relation.to);
  if (!type || !from || !to) return null;
  if (from === to && !CHAIN_SELF_TYPES.includes(type)) return null;
  const sources = Array.isArray(relation.sources)
    ? relation.sources.map((item) => String(item)).filter(Boolean).slice(0, 6)
    : (relation.source ? [String(relation.source)] : []);
  return {
    type,
    from,
    to,
    confidence: confidenceOf(relation.confidence),
    source: relation.source ? String(relation.source) : (sources[0] || null),
    sources,
    depth: Number.isFinite(Number(relation.depth)) ? Math.max(0, Math.round(Number(relation.depth))) : null,
    chain: Array.isArray(relation.chain) ? relation.chain.map((item) => String(item)).slice(0, 12) : null,
  };
}

/** 关系图 → 去重后的边列表。 */
export function normalizeRelationGraph(graph, options = {}) {
  const maxLinks = limitOf(options.limits && options.limits.links, CHAIN_LIMITS.links, 20000);
  const raw = graph && Array.isArray(graph.relations) ? graph.relations : [];
  const seen = new Set();
  const links = [];
  let dropped = 0;
  for (const relation of raw) {
    const link = normalizeRelationLink(relation);
    if (!link) { dropped += 1; continue; }
    if (links.length >= maxLinks) { dropped += 1; continue; }
    const key = link.type + '\u0000' + link.from + '\u0000' + link.to;
    if (seen.has(key)) { dropped += 1; continue; }
    seen.add(key);
    links.push(link);
  }
  return {
    version: VOM_RELATION_CHAIN_VERSION,
    links,
    truncated: dropped > 0,
    dropped,
    sourceVersion: graph && Number.isFinite(Number(graph.version)) ? Number(graph.version) : null,
  };
}

function pushIndex(map, key, link) {
  const list = map.get(key);
  if (list) list.push(link);
  else map.set(key, [link]);
}

/** 建双向索引：out[id] = 以 id 为 from 的边；in[id] = 以 id 为 to 的边。 */
export function buildRelationIndex(graph, options = {}) {
  const normalized = normalizeRelationGraph(graph, options);
  const out = new Map();
  const inMap = new Map();
  const ids = new Set();
  const byType = {};
  for (const link of normalized.links) {
    pushIndex(out, link.from, link);
    pushIndex(inMap, link.to, link);
    ids.add(link.from);
    ids.add(link.to);
    byType[link.type] = (byType[link.type] || 0) + 1;
  }
  // 高置信度优先，保证 depth 内的链选择稳定可解释。
  for (const list of out.values()) list.sort((a, b) => b.confidence - a.confidence || String(a.source).localeCompare(String(b.source)));
  for (const list of inMap.values()) list.sort((a, b) => b.confidence - a.confidence || String(a.source).localeCompare(String(b.source)));
  return {
    version: VOM_RELATION_CHAIN_VERSION,
    graph: normalized,
    links: normalized.links,
    out,
    in: inMap,
    ids,
    byType,
    truncated: normalized.truncated,
    dropped: normalized.dropped,
  };
}

function chainStep(link, direction, depth, nodeId) {
  return {
    id: direction === 'in' ? link.from : link.to,
    from: link.from,
    to: link.to,
    type: link.type,
    direction,
    confidence: link.confidence,
    source: link.source,
    depth,
    via: nodeId,
    ...(link.chain ? { chain: link.chain } : {}),
  };
}

/**
 * 从某节点沿单一关系类型走一条链（默认取最高置信度分支）。
 * @param {{out:Map,in:Map}} index buildRelationIndex() 结果
 * @param {string} nodeId
 * @param {string} type
 * @param {{direction?:'in'|'out', maxDepth?:number, minConfidence?:number, steps?:number}} [options]
 */
export function resolveRelationChain(index, nodeId, type, options = {}) {
  const start = idOf(nodeId);
  const wantedType = typeOf(type);
  if (!start || !wantedType || !index || !(index.out instanceof Map)) {
    return { nodeId: start, type: wantedType, direction: null, steps: [], reached: 0, cycle: false, ambiguous: 0 };
  }
  const defaults = CHAIN_DIRECTIONS[wantedType] || 'in';
  const direction = options.direction === 'out' ? 'out' : options.direction === 'in' ? 'in' : defaults;
  const maxDepth = limitOf(options.maxDepth, CHAIN_LIMITS.depth, 16);
  const maxSteps = limitOf(options.steps, CHAIN_LIMITS.steps, 128);
  const minConfidence = Math.min(Math.max(Number(options.minConfidence) || 0, 0), 1);
  const map = direction === 'in' ? index.in : index.out;
  const steps = [];
  const visited = new Set([start]);
  let current = start;
  let ambiguous = 0;
  let cycle = false;
  for (let depth = 1; depth <= maxDepth && steps.length < maxSteps; depth += 1) {
    const candidates = (map.get(current) || []).filter((link) => link.type === wantedType && link.confidence >= minConfidence);
    if (!candidates.length) break;
    if (candidates.length > 1) ambiguous += candidates.length - 1;
    const link = candidates[0];
    const next = direction === 'in' ? link.from : link.to;
    if (next === current) break;
    if (visited.has(next)) { cycle = true; break; }
    visited.add(next);
    steps.push(chainStep(link, direction, depth, current));
    current = next;
  }
  return {
    nodeId: start,
    type: wantedType,
    direction,
    steps,
    reached: steps.length,
    endId: steps.length ? steps[steps.length - 1].id : null,
    cycle,
    ambiguous,
  };
}

/** ownership 链：owns 追到 owner，再沿 contains 向上补容器；返回混合链。 */
export function buildOwnershipPath(index, nodeId, options = {}) {
  const owns = resolveRelationChain(index, nodeId, 'owns', { ...options, maxDepth: limitOf(options.maxDepth, CHAIN_LIMITS.depth, 16) });
  const containerStart = owns.steps.length ? owns.steps[owns.steps.length - 1].id : nodeId;
  const contains = resolveRelationChain(index, containerStart, 'contains', { ...options, maxDepth: Math.max(1, limitOf(options.maxDepth, CHAIN_LIMITS.depth, 16) - 1) });
  return {
    nodeId: idOf(nodeId),
    owners: owns.steps,
    containers: contains.steps,
    path: owns.steps.concat(contains.steps),
  };
}

function edgesFor(index, id) {
  return {
    incoming: (index.in.get(id) || []).length,
    outgoing: (index.out.get(id) || []).length,
  };
}

/**
 * 关系图 → 每个节点的全链报告。
 * @param {object} graph vom-relations 输出
 * @param {{nodes?:object[], ids?:string[], limits?:object}} [options]
 */
export function buildRelationChains(graph, options = {}) {
  const index = buildRelationIndex(graph, options);
  const meta = nodeMetaOf(options.nodes);
  const maxNodes = limitOf(options.limits && options.limits.nodes, CHAIN_LIMITS.nodes, 1000);
  const explicit = Array.isArray(options.ids) ? options.ids.map((id) => idOf(id)).filter(Boolean) : [];
  // 没显式给 ids 时，优先取“关系最多”的节点，保证输出覆盖最值得解释的那批。
  const ranked = explicit.length
    ? explicit
    : Array.from(index.ids)
      .map((id) => ({ id, degree: (index.in.get(id) || []).length + (index.out.get(id) || []).length }))
      .sort((a, b) => b.degree - a.degree || String(a.id).localeCompare(String(b.id)))
      .map((item) => item.id);
  const ids = ranked.slice(0, maxNodes);
  const chainOptions = {
    ...(options.chainOptions && typeof options.chainOptions === 'object' ? options.chainOptions : {}),
    maxDepth: limitOf(options.limits && options.limits.depth, CHAIN_LIMITS.depth, 16),
  };
  const chains = [];
  let truncated = index.truncated || ranked.length > ids.length;
  for (const id of ids) {
    const entry = { id, ...(meta.get(id) ? { role: meta.get(id).role, name: meta.get(id).name, tag: meta.get(id).tag } : {}) };
    const edges = edgesFor(index, id);
    entry.edges = edges;
    for (const type of CHAIN_TYPES) {
      const chain = resolveRelationChain(index, id, type, chainOptions);
      entry[type] = chain.steps;
      if (chain.steps.length) entry[type + 'End'] = chain.endId;
      if (chain.cycle) entry[type + 'Cycle'] = true;
      if (chain.ambiguous) entry[type + 'Ambiguous'] = chain.ambiguous;
    }
    entry.ownership = buildOwnershipPath(index, id, chainOptions);
    chains.push(entry);
  }
  const integrity = checkRelationChainIntegrity(graph, { knownIds: options.knownIds || null, limits: options.limits || {} });
  return {
    version: VOM_RELATION_CHAIN_VERSION,
    available: index.links.length > 0,
    nodes: chains,
    counts: {
      nodes: chains.length,
      links: index.links.length,
      types: Object.keys(index.byType).length,
      byType: { ...index.byType },
      chained: chains.filter((item) => CHAIN_TYPES.some((type) => item[type] && item[type].length)).length,
      ownershipPaths: chains.filter((item) => item.ownership && item.ownership.path.length).length,
    },
    integrity,
    truncated,
  };
}

/**
 * 任意两节点之间的关系路径（双向遍历；路径内每条边带 direction）。
 * @param {object} graph
 * @param {{from:string, to:string, types?:string[], maxDepth?:number, limit?:number, minConfidence?:number}} [options]
 */
export function findRelationPaths(graph, options = {}) {
  const index = buildRelationIndex(graph, options);
  const from = idOf(options.from);
  const to = idOf(options.to);
  const types = Array.isArray(options.types) && options.types.length
    ? options.types.map((type) => typeOf(type)).filter(Boolean)
    : CHAIN_TYPES.slice();
  const maxDepth = limitOf(options.maxDepth, CHAIN_LIMITS.pathDepth, 12);
  const limit = limitOf(options.limit, CHAIN_LIMITS.paths, 32);
  const minConfidence = Math.min(Math.max(Number(options.minConfidence) || 0, 0), 1);
  const result = {
    version: VOM_RELATION_CHAIN_VERSION,
    available: Boolean(from && to && (index.ids.has(from) || index.ids.has(to))),
    from,
    to,
    types,
    paths: [],
    truncated: false,
    explored: 0,
  };
  if (!from || !to) return result;
  if (from === to) {
    result.paths.push({ length: 0, steps: [] });
    return result;
  }
  const search = (current, visited, steps) => {
    if (result.paths.length >= limit) { result.truncated = true; return; }
    if (steps.length >= maxDepth) return;
    result.explored += 1;
    const incident = [];
    for (const link of index.out.get(current) || []) incident.push({ link, direction: 'out', next: link.to });
    for (const link of index.in.get(current) || []) incident.push({ link, direction: 'in', next: link.from });
    incident.sort((a, b) => b.link.confidence - a.link.confidence);
    for (const { link, direction, next } of incident) {
      if (!types.includes(link.type) || link.confidence < minConfidence) continue;
      if (visited.has(next)) continue;
      const step = {
        id: next,
        from: link.from,
        to: link.to,
        type: link.type,
        direction,
        confidence: link.confidence,
        source: link.source,
      };
      const pathSteps = steps.concat([step]);
      if (next === to) {
        result.paths.push({ length: pathSteps.length, steps: pathSteps });
        if (result.paths.length >= limit) { result.truncated = true; return; }
        continue;
      }
      const nextVisited = new Set(visited);
      nextVisited.add(next);
      search(next, nextVisited, pathSteps);
    }
  };
  search(from, new Set([from]), []);
  // 最短路优先：调用方通常只关心“有没有路径/最直接的证据”。
  result.paths.sort((a, b) => a.length - b.length || String(a.steps.map((step) => step.type).join(',')).localeCompare(String(b.steps.map((step) => step.type).join(','))));
  return result;
}

/** 关系图完整性：悬空端点 / 重复 / 未知类型 / 自环 / 环。 */
export function checkRelationChainIntegrity(graph, options = {}) {
  const limits = { ...CHAIN_LIMITS, ...(options.limits && typeof options.limits === 'object' ? options.limits : {}) };
  const normalized = normalizeRelationGraph(graph, { limits });
  const links = normalized.links;
  const knownIds = options.knownIds instanceof Set
    ? options.knownIds
    : (Array.isArray(options.knownIds) ? new Set(options.knownIds.map(String)) : null);
  const dangling = [];
  const duplicates = [];
  const selfLoop = [];
  const unknownTypes = [];
  const seen = new Map();
  for (const link of links) {
    if (!CHAIN_TYPES.includes(link.type)) {
      if (unknownTypes.length < limits.dangling) unknownTypes.push({ type: link.type, from: link.from, to: link.to });
      continue;
    }
    if (knownIds) {
      const missing = [];
      if (!knownIds.has(link.from)) missing.push('from');
      if (!knownIds.has(link.to)) missing.push('to');
      if (missing.length && dangling.length < limits.dangling) dangling.push({ type: link.type, from: link.from, to: link.to, missing });
    }
    if (link.from === link.to && !CHAIN_SELF_TYPES.includes(link.type) && selfLoop.length < limits.dangling) {
      selfLoop.push({ type: link.type, id: link.from });
    }
    const key = link.type + '\u0000' + link.from + '\u0000' + link.to;
    const count = (seen.get(key) || 0) + 1;
    seen.set(key, count);
    if (count === 2 && duplicates.length < limits.dangling) duplicates.push({ type: link.type, from: link.from, to: link.to, count });
  }
  // 按类型找环（每类最多 limits.cycles 条）。
  const cycles = [];
  for (const type of CHAIN_TYPES) {
    if (cycles.length >= limits.cycles) break;
    const adjacency = new Map();
    for (const link of links) {
      if (link.type !== type || link.from === link.to) continue;
      const list = adjacency.get(link.from) || [];
      list.push(link.to);
      adjacency.set(link.from, list);
    }
    const visiting = new Set();
    const visited = new Set();
    const stack = [];
    const walk = (node) => {
      if (cycles.length >= limits.cycles) return;
      if (visiting.has(node)) {
        const start = stack.indexOf(node);
        if (start >= 0) cycles.push({ type, ids: stack.slice(start).concat([node]).slice(0, 12) });
        return;
      }
      if (visited.has(node)) return;
      visiting.add(node);
      stack.push(node);
      for (const next of adjacency.get(node) || []) walk(next);
      stack.pop();
      visiting.delete(node);
      visited.add(node);
    };
    for (const node of adjacency.keys()) walk(node);
  }
  const issues = dangling.length + duplicates.length + selfLoop.length + unknownTypes.length + cycles.length;
  return {
    version: VOM_RELATION_CHAIN_VERSION,
    ok: issues === 0 && !normalized.truncated,
    available: links.length > 0,
    counts: {
      links: links.length,
      ids: new Set(links.flatMap((link) => [link.from, link.to])).size,
      dangling: dangling.length,
      duplicates: duplicates.length,
      selfLoop: selfLoop.length,
      unknownTypes: unknownTypes.length,
      cycles: cycles.length,
    },
    dangling,
    duplicates,
    selfLoop,
    unknownTypes,
    cycles,
    truncated: normalized.truncated,
  };
}

/** JSON 安全摘要（observe 输出 vomRelationChains）。 */
export function summarizeRelationChains(report, options = {}) {
  if (!report || typeof report !== 'object') {
    return {
      version: VOM_RELATION_CHAIN_VERSION,
      available: false,
      counts: { nodes: 0, links: 0, chained: 0 },
      integrity: { ok: false, counts: {} },
      chains: [],
    };
  }
  const maxNodes = limitOf(options.nodes, 24, 200);
  return {
    version: report.version || VOM_RELATION_CHAIN_VERSION,
    available: report.available === true,
    counts: { ...(report.counts || {}) },
    integrity: report.integrity
      ? { ok: report.integrity.ok === true, counts: { ...(report.integrity.counts || {}) }, cycles: (report.integrity.cycles || []).slice(0, 3), dangling: (report.integrity.dangling || []).slice(0, 3) }
      : null,
    truncated: report.truncated === true,
    chains: (Array.isArray(report.nodes) ? report.nodes : []).slice(0, maxNodes).map((entry) => ({
      id: entry.id,
      role: entry.role || null,
      name: entry.name || null,
      edges: entry.edges,
      contains: entry.contains,
      owns: entry.owns,
      labels: entry.labels,
      controls: entry.controls,
      describes: entry.describes,
      invalidates: entry.invalidates,
      ownership: entry.ownership ? {
        owners: entry.ownership.owners,
        containers: entry.ownership.containers,
      } : null,
    })),
  };
}

/** 一行诊断文本。 */
export function describeRelationChains(summary) {
  if (!summary || typeof summary !== 'object') return '';
  const counts = summary.counts || {};
  const integrity = summary.integrity || {};
  const parts = ['chains nodes=' + (counts.nodes || 0) + ' links=' + (counts.links || 0)];
  if (counts.chained) parts.push('chained=' + counts.chained);
  if (integrity.ok === false) {
    const ic = integrity.counts || {};
    const issues = ['dangling', 'duplicates', 'cycles', 'selfLoop', 'unknownTypes']
      .filter((key) => Number(ic[key]) > 0)
      .map((key) => key + '=' + Number(ic[key]));
    if (issues.length) parts.push('integrity=' + issues.join('+'));
  }
  if (summary.truncated) parts.push('truncated');
  return parts.join(' ');
}

export function relationChainVersion() {
  return VOM_RELATION_CHAIN_VERSION;
}
