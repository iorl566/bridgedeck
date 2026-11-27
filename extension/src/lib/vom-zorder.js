// lib/vom-zorder.js —— 绘制栈（paint-order）/ 遮挡链 / 命中测试的显式模型（纯函数，可单测）。
//
// 与 lib/vom-visibility.js 的分工：
//   - vom-visibility 回答“这个节点能不能看/能不能点”（per-node gate，给丢弃原因）；
//   - 本模块回答“当前页面到底按什么顺序画、一个点最先落到谁、谁挡住了谁”的**链式证据**：
//       1) stack：层事实 + 节点几何合并、去重后的绘制栈（后 → 前），带 rank/zIndex/paintOrder；
//       2) chains：每个节点被哪些更靠前的元素覆盖（front → back，多条而不是只记第一个），
//          以及“遮挡者又是否被别的元素挡住”的两跳归因；
//       3) hit：给一组采样点（视口中心/四分点/显式探针）做 pâint-order 命中测试，
//          明确 pointer-events:none 被穿透、阻挡层命中，而不是假装知道；
//       4) evidence/missing：没有几何、没有层、没有 hitTest 事实时结构化标注缺失，
//          不补造 z-index / rect / 命中结果。
//
// 纯函数：不读 DOM、不碰 CDP。输入全部来自 observe 已采集的事实。

export const VOM_ZORDER_VERSION = 1;

/** 与 vom-layers 一致的层种类排序（后 → 前）。 */
const LAYER_RANK = Object.freeze({ base: 0, 'fixed-sticky': 1, floating: 2, blocking: 3, 'top-layer': 4 });

export const ZORDER_LIMITS = Object.freeze({
  stack: 160,
  chains: 240,
  chainDepth: 8,
  points: 8,
  candidates: 32,
  occluders: 32,
});

/** 结构化缺失原因：输出里如实标注“这条证据没采到”，绝不伪造。 */
export const ZORDER_MISSING = Object.freeze({
  geometry: 'geometry-missing',
  layers: 'layers-missing',
  paintOrder: 'paint-order-missing',
  hitTest: 'hit-test-missing',
  viewport: 'viewport-missing',
  stack: 'stack-truncated',
});

function limitOf(value, fallback, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.floor(number), max);
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function lower(value) {
  return String(value == null ? '' : value).toLowerCase();
}

/** 接受 rect/bounds 以及页面侧 {x,y,w,h}；不完整时返回 null（不猜）。 */
export function zorderRect(item) {
  if (!item || typeof item !== 'object') return null;
  const source = item.rect || item.bounds || null;
  if (!source || typeof source !== 'object') return null;
  const x = numberOrNull(source.x);
  const y = numberOrNull(source.y);
  const width = numberOrNull(source.width != null ? source.width : source.w);
  const height = numberOrNull(source.height != null ? source.height : source.h);
  if (x === null || y === null || width === null || height === null) return null;
  if (width < 0 || height < 0) return null;
  return { x, y, width, height };
}

export function zorderArea(rect) {
  if (!rect) return 0;
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

function overlapArea(a, b) {
  if (!a || !b) return 0;
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (width <= 0 || height <= 0) return 0;
  return width * height;
}

function containsPoint(rect, point) {
  if (!rect || !point) return false;
  return point.x >= rect.x && point.x <= rect.x + rect.width
    && point.y >= rect.y && point.y <= rect.y + rect.height;
}

/** 稳定 id：ref > stableRef > 图 key > DOM id#domId > 合成下标；没有身份时返回 null。 */
export function zorderId(item, fallbackIndex = -1) {
  if (!item || typeof item !== 'object') return null;
  // 观察节点优先用 ref（@eN）/stableRef，DOM id 只是页面属性，跨帧可能重复。
  if (item.ref) return String(item.ref);
  if (item.stableRef) return String(item.stableRef);
  if (item.graphKey) return 'vom:' + String(item.graphKey);
  if (item.id != null && String(item.id) !== '') return String(item.id);
  if (item.domId) return item.tag ? lower(item.tag) + '#' + String(item.domId) : String(item.domId);
  return fallbackIndex >= 0 ? 'z:i' + fallbackIndex : null;
}

function kindOf(item) {
  const kind = lower(item && (item.layerKind || item.kind));
  if (kind && LAYER_RANK[kind] != null) return kind;
  if (item && item.topLayer) return 'top-layer';
  return 'floating';
}

function pointerEventsOf(item) {
  if (!item || typeof item !== 'object') return null;
  if (item.pointerEvents != null) return String(item.pointerEvents);
  const styles = item.styles && typeof item.styles === 'object' ? item.styles : null;
  if (styles && styles['pointer-events'] != null) return String(styles['pointer-events']);
  return null;
}

function ancestorIdsOf(item) {
  const out = new Set();
  if (!item || typeof item !== 'object') return out;
  if (Array.isArray(item.ancestorIds)) for (const id of item.ancestorIds) if (id != null) out.add(String(id));
  if (Array.isArray(item.ancestors)) {
    for (const ancestor of item.ancestors) {
      if (!ancestor || typeof ancestor !== 'object') continue;
      const id = ancestor.id != null ? ancestor.id : (ancestor.ref || null);
      if (id != null) out.add(String(id));
    }
  }
  return out;
}

/**
 * 单条层/节点事实 → 绘制栈候选。
 * @param {object} item
 * @param {{sourceIndex?:number, fromLayers?:boolean}} [options]
 */
export function normalizeZorderItem(item, options = {}) {
  if (!item || typeof item !== 'object') return null;
  const sourceIndex = Number.isInteger(options.sourceIndex) ? options.sourceIndex : -1;
  const id = zorderId(item, sourceIndex);
  if (!id) return null;
  const kind = kindOf(item);
  const role = item.role == null ? null : lower(item.role);
  const zIndex = numberOrNull(item.zIndex != null ? item.zIndex : (item.styles && item.styles['z-index']));
  const paintOrder = numberOrNull(item.paintOrder);
  const coverage = numberOrNull(item.coverage);
  const rect = zorderRect(item);
  const blocking = item.blocking === true
    || kind === 'blocking'
    || kind === 'top-layer'
    || ['dialog', 'alertdialog', 'overlay', 'mask', 'backdrop'].includes(role);
  return {
    id,
    kind,
    rank: LAYER_RANK[kind] != null ? LAYER_RANK[kind] : 2,
    role,
    name: item.name == null ? null : String(item.name).slice(0, 80),
    tag: item.tag == null ? null : lower(item.tag),
    rect,
    zIndex,
    paintOrder,
    blocking,
    pointerEvents: pointerEventsOf(item),
    topLayer: item.topLayer ? String(item.topLayer) : null,
    coverage,
    hitTest: item.hitTest == null ? null : String(item.hitTest),
    ancestorIds: ancestorIdsOf(item),
    fromLayers: options.fromLayers === true,
    sourceIndex,
  };
}

function sortValue(item) {
  return [
    item.rank,
    item.zIndex == null ? 0 : item.zIndex,
    item.paintOrder == null ? 0 : item.paintOrder,
    item.sourceIndex,
  ];
}

/** 绘制顺序比较（负数 = a 先画，即更靠后）。 */
export function compareZorder(a, b) {
  const left = sortValue(a || {});
  const right = sortValue(b || {});
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function mergeItem(previous, next) {
  // 层事实一般没有几何/z-index 细节；节点事实有几何和 hitTest。同 id 时合并成一条，
  // 层提供 blocking/kind，节点提供 rect/pointerEvents/paintOrder。
  return {
    ...previous,
    ...next,
    kind: next.kind === 'floating' && previous.kind && previous.fromLayers ? previous.kind : next.kind,
    rank: next.fromLayers === false && previous.fromLayers ? previous.rank : next.rank,
    blocking: previous.blocking === true || next.blocking === true,
    rect: next.rect || previous.rect,
    zIndex: next.zIndex != null ? next.zIndex : previous.zIndex,
    paintOrder: next.paintOrder != null ? next.paintOrder : previous.paintOrder,
    coverage: next.coverage != null ? next.coverage : previous.coverage,
    pointerEvents: next.pointerEvents != null ? next.pointerEvents : previous.pointerEvents,
    hitTest: next.hitTest != null ? next.hitTest : previous.hitTest,
    topLayer: next.topLayer || previous.topLayer,
    role: next.role || previous.role,
    name: next.name || previous.name,
    tag: next.tag || previous.tag,
    ancestorIds: next.ancestorIds && next.ancestorIds.size ? next.ancestorIds : previous.ancestorIds,
    fromLayers: previous.fromLayers && next.fromLayers,
  };
}

function defaultPoints(viewport, explicit) {
  if (Array.isArray(explicit) && explicit.length) {
    return explicit
      .filter((point) => point && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y)))
      .map((point) => ({ x: Number(point.x), y: Number(point.y), label: point.label ? String(point.label) : null }))
      .slice(0, ZORDER_LIMITS.points);
  }
  if (!viewport) return [];
  const x = Number(viewport.x) || 0;
  const y = Number(viewport.y) || 0;
  const width = Number(viewport.width) || 0;
  const height = Number(viewport.height) || 0;
  if (!(width > 0 && height > 0)) return [];
  return [
    { x: Math.round(x + width / 2), y: Math.round(y + height / 2), label: 'viewport-center' },
    { x: Math.round(x + width / 4), y: Math.round(y + height / 4), label: 'viewport-quarter' },
    { x: Math.round(x + (width * 3) / 4), y: Math.round(y + (height * 3) / 4), label: 'viewport-three-quarter' },
  ];
}

function hitTestPoint(model, point) {
  const candidates = [];
  for (let index = model.stack.length - 1; index >= 0; index -= 1) {
    const item = model.stack[index];
    if (!item.rect) continue;
    if (!containsPoint(item.rect, point)) continue;
    const transparent = lower(item.pointerEvents) === 'none';
    candidates.push({ id: item.id, kind: item.kind, blocking: item.blocking, paintIndex: item.paintIndex, pointerEvents: item.pointerEvents, passThrough: transparent });
    if (candidates.length >= ZORDER_LIMITS.candidates) break;
  }
  const hit = candidates.find((item) => item.passThrough !== true) || null;
  return {
    x: point.x,
    y: point.y,
    label: point.label || null,
    inside: candidates.length > 0,
    hitId: hit ? hit.id : null,
    hitKind: hit ? hit.kind : null,
    blockingHit: Boolean(hit && hit.blocking),
    candidates,
    evidence: candidates.length ? 'geometry' : 'none',
  };
}

/**
 * 构建绘制栈 / 遮挡链 / 命中测试模型。
 * @param {{layers?:object[], nodes?:object[], viewport?:object|null, points?:Array<{x:number,y:number}>, limits?:object}} [input]
 */
export function buildZOrderModel(input = {}) {
  const limits = { ...ZORDER_LIMITS, ...(input.limits && typeof input.limits === 'object' ? input.limits : {}) };
  const maxStack = limitOf(limits.stack, ZORDER_LIMITS.stack, 1000);
  const maxChains = limitOf(limits.chains, ZORDER_LIMITS.chains, 2000);
  const maxDepth = limitOf(limits.chainDepth, ZORDER_LIMITS.chainDepth, 16);
  const threshold = Math.min(Math.max(Number(limits.threshold) || 0.2, 0.01), 1);
  const layerList = Array.isArray(input.layers) ? input.layers : [];
  const nodeList = Array.isArray(input.nodes) ? input.nodes : [];

  const byId = new Map();
  let layerGeom = 0;
  let nodeGeom = 0;
  let paintOrderFacts = 0;
  let hitTestFacts = 0;
  const add = (item) => {
    if (!item) return;
    if (item.rect) {
      if (item.fromLayers) layerGeom += 1;
      else nodeGeom += 1;
    }
    if (item.paintOrder != null) paintOrderFacts += 1;
    if (item.hitTest) hitTestFacts += 1;
    const existing = byId.get(item.id);
    byId.set(item.id, existing ? mergeItem(existing, item) : item);
  };
  layerList.forEach((item, index) => add(normalizeZorderItem(item, { sourceIndex: index, fromLayers: true })));
  nodeList.forEach((item, index) => add(normalizeZorderItem(item, { sourceIndex: index, fromLayers: false })));

  const items = Array.from(byId.values()).sort(compareZorder);
  const stack = [];
  for (const item of items) {
    if (stack.length >= maxStack) break;
    stack.push({ ...item, paintIndex: stack.length });
  }
  const stackById = new Map(stack.map((item) => [item.id, item]));

  const chains = [];
  let truncatedChains = false;
  for (const target of stack) {
    if (!target.rect) continue;
    if (chains.length >= maxChains) { truncatedChains = true; break; }
    const area = zorderArea(target.rect);
    if (!(area > 0)) continue;
    const occluders = [];
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      const candidate = stack[index];
      if (candidate.id === target.id) continue;
      if (candidate.paintIndex <= target.paintIndex) continue;
      if (!candidate.rect) continue;
      if (target.ancestorIds.has(candidate.id) || candidate.ancestorIds.has(target.id)) continue;
      const coverage = overlapArea(target.rect, candidate.rect) / area;
      if (coverage < threshold) continue;
      occluders.push({
        id: candidate.id,
        kind: candidate.kind,
        blocking: candidate.blocking,
        paintIndex: candidate.paintIndex,
        coverage: Math.round(Math.min(1, coverage) * 1000) / 1000,
        pointerEvents: candidate.pointerEvents,
      });
      if (occluders.length >= maxDepth) break;
    }
    if (occluders.length) {
      chains.push({
        id: target.id,
        occluders,
        top: occluders[0].id,
        // 两跳归因：最前面的遮挡者自己是否也被挡住（用于判断“真正挡在前面的是谁”）。
        topOccluderChain: occluders[0] ? (() => {
          const next = chains.find((chain) => chain.id === occluders[0].id);
          return next ? next.occluders.slice(0, 2).map((item) => item.id) : [];
        })() : [],
        maxCoverage: occluders[0].coverage,
      });
    }
  }
  const chainById = new Map(chains.map((chain) => [chain.id, chain]));

  const points = defaultPoints(input.viewport, input.points);
  const hit = points.map((point) => hitTestPoint({ stack }, point));

  const blockingFront = stack.filter((item) => item.blocking).slice(-8).map((item) => ({
    id: item.id,
    kind: item.kind,
    paintIndex: item.paintIndex,
    name: item.name,
    role: item.role,
    rect: item.rect,
  }));

  const missing = [];
  if (!layerList.length) missing.push({ evidence: 'layers', reason: ZORDER_MISSING.layers });
  if (!nodeGeom && !layerGeom) missing.push({ evidence: 'geometry', reason: ZORDER_MISSING.geometry });
  if (!paintOrderFacts) missing.push({ evidence: 'paint-order', reason: ZORDER_MISSING.paintOrder });
  if (!hitTestFacts) missing.push({ evidence: 'hit-test', reason: ZORDER_MISSING.hitTest });
  if (!points.length) missing.push({ evidence: 'viewport', reason: ZORDER_MISSING.viewport });
  if (items.length > stack.length) missing.push({ evidence: 'stack', reason: ZORDER_MISSING.stack, dropped: items.length - stack.length });

  const occludedNodes = chains.length;
  const blockedNodes = chains.filter((chain) => chain.occluders.some((item) => item.blocking)).length;
  return {
    version: VOM_ZORDER_VERSION,
    // available 只表示“有带几何的绘制项”；仅有无几何的节点不算能画栈。
    available: stack.some((item) => Boolean(item.rect)),
    viewport: input.viewport || null,
    stack,
    byId: stackById,
    chains,
    chainById,
    hit,
    topBlocking: blockingFront,
    evidence: {
      layers: { available: layerList.length > 0, count: layerList.length, withGeometry: layerGeom },
      geometry: { available: nodeGeom + layerGeom > 0, nodes: nodeGeom, layers: layerGeom },
      paintOrder: { available: paintOrderFacts > 0, count: paintOrderFacts },
      hitTest: { available: hitTestFacts > 0, count: hitTestFacts },
      viewport: { available: points.length > 0, points: points.length },
    },
    counts: {
      layers: layerList.length,
      nodes: nodeList.length,
      items: items.length,
      stack: stack.length,
      chains: chains.length,
      occludedNodes,
      blockedNodes,
      points: hit.length,
      topBlocking: blockingFront.length,
      maxChain: chains.reduce((max, chain) => Math.max(max, chain.occluders.length), 0),
    },
    missing,
    truncated: items.length > stack.length || truncatedChains,
    limits: { stack: maxStack, chains: maxChains, chainDepth: maxDepth, threshold },
  };
}

/** 单点命中测试（复用已建模型的栈；不做二次排序）。 */
export function resolveHitTest(model, point) {
  if (!model || !Array.isArray(model.stack) || !point) {
    return { x: point ? Number(point.x) : null, y: point ? Number(point.y) : null, inside: false, hitId: null, candidates: [], evidence: 'none' };
  }
  const normalized = { x: Number(point.x), y: Number(point.y), label: point.label ? String(point.label) : null };
  if (!Number.isFinite(normalized.x) || !Number.isFinite(normalized.y)) {
    return { x: null, y: null, inside: false, hitId: null, candidates: [], evidence: 'none' };
  }
  return hitTestPoint(model, normalized);
}

/** 某节点的完整遮挡链（front → back）；没有几何/无遮挡时返回空数组。 */
export function occlusionChainFor(model, nodeId) {
  if (!model || !(model.chainById instanceof Map)) return [];
  const chain = model.chainById.get(String(nodeId));
  return chain ? chain.occluders.slice() : [];
}

/** 两个绘制栈元素的先后：负数 a 先画；未知返回 null（不猜）。 */
export function paintOrderBetween(model, leftId, rightId) {
  if (!model || !(model.byId instanceof Map)) return null;
  const left = model.byId.get(String(leftId));
  const right = model.byId.get(String(rightId));
  if (!left || !right) return null;
  return compareZorder(left, right);
}

/** JSON 安全的摘要（observe / payload 输出用；Map 不落盘）。 */
export function summarizeZOrder(model, options = {}) {
  if (!model || typeof model !== 'object') {
    return {
      version: VOM_ZORDER_VERSION,
      available: false,
      counts: { layers: 0, nodes: 0, stack: 0, chains: 0, points: 0 },
      stack: [],
      occluded: [],
      hit: [],
      topBlocking: [],
      evidence: {},
      missing: [{ evidence: 'model', reason: 'not-built' }],
      truncated: false,
    };
  }
  const maxStack = limitOf(options.stack, 12, 100);
  const maxChains = limitOf(options.chains, 12, 100);
  const maxPoints = limitOf(options.points, 4, 32);
  return {
    version: model.version || VOM_ZORDER_VERSION,
    available: model.available === true,
    counts: { ...(model.counts || {}) },
    ...(model.viewport ? { viewport: model.viewport } : {}),
    stack: (Array.isArray(model.stack) ? model.stack : []).slice(0, maxStack).map((item) => ({
      id: item.id,
      kind: item.kind,
      paintIndex: item.paintIndex,
      zIndex: item.zIndex,
      paintOrder: item.paintOrder,
      blocking: item.blocking,
      pointerEvents: item.pointerEvents,
      rect: item.rect,
      role: item.role,
      name: item.name,
    })),
    occluded: (Array.isArray(model.chains) ? model.chains : []).slice(0, maxChains).map((chain) => ({
      id: chain.id,
      top: chain.top,
      maxCoverage: chain.maxCoverage,
      occluders: chain.occluders.slice(0, ZORDER_LIMITS.chainDepth),
    })),
    hit: (Array.isArray(model.hit) ? model.hit : []).slice(0, maxPoints),
    topBlocking: Array.isArray(model.topBlocking) ? model.topBlocking.slice(0, 8) : [],
    evidence: model.evidence || {},
    missing: Array.isArray(model.missing) ? model.missing.slice(0, 12) : [],
    truncated: model.truncated === true,
    ...(model.limits ? { limits: model.limits } : {}),
  };
}

/** 一行诊断文本（observe 的 vomZOrderText）。 */
export function describeZOrder(summary) {
  if (!summary || typeof summary !== 'object') return '';
  const counts = summary.counts || {};
  const parts = ['zorder stack=' + (counts.stack || 0)];
  if (counts.chains) parts.push('occluded=' + counts.chains);
  if (counts.points) parts.push('points=' + counts.points);
  const hit = Array.isArray(summary.hit) ? summary.hit.find((item) => item && item.inside) : null;
  if (hit) parts.push('center=' + String(hit.hitId || 'none'));
  const missing = Array.isArray(summary.missing) ? summary.missing.map((item) => item.reason) : [];
  if (missing.length) parts.push('missing=' + missing.join('+'));
  return parts.join(' ');
}

export function zorderVersion() {
  return VOM_ZORDER_VERSION;
}
