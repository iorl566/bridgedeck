// lib/vom-visibility.js —— paint-order + 可见性/遮挡/pointer-events 的统一 gate。
//
// 旧代码里“这个节点算不算可见/可交互”散落在多处：vom-weights 自己判 offscreen/hidden，
// blocking-layers 自己判 visible/pointer-events，observation 自己按 visible/aria-hidden 过滤，
// payload 又把各字段原样透出。判定口径一旦分叉，诊断和排序就会互相矛盾。
//
// 这里集中成一处：
//   - evaluateVisibility(node, {occluder}) → 唯一判定（paintable / visible / interactive + reasons）；
//   - resolveOcclusion(nodes, {layers})    → 用 paint-order + 层模型 + 几何求出遮挡者；
//   - applyVisibilityGate(nodes, {mode})   → 按 gate 模式过滤并给出每个节点被丢弃的原因；
//   - visibilityFlags(node)                → 兼容 vom-weights 的既有打分口径（分值不变）。
//
// 纯函数；不读 DOM，不碰 CDP。页面侧只负责提供事实（paintVisible/clipped/pointerEvents/anchor）。

export const VOM_VISIBILITY_VERSION = 1;

/** 不可见原因（顺序即主原因优先级）。 */
export const VISIBILITY_REASONS = Object.freeze([
  'detached',
  'paint-hidden',
  'aria-hidden',
  'offscreen',
  'clipped',
  'pointer-events-none',
  'occluded',
  'blocking-layer',
  'recycled-row',
]);

/** gate 模式：每种模式丢弃哪些原因。 */
export const GATE_MODES = Object.freeze({
  // 只关心“画不出来”（display/visibility/opacity/aria-hidden/detached）。
  paintable: Object.freeze(['detached', 'paint-hidden', 'aria-hidden']),
  // 画得出来且当前视口内、没有被裁剪。
  visible: Object.freeze(['detached', 'paint-hidden', 'aria-hidden', 'offscreen', 'clipped']),
  // 可以安全派发指针动作：再加 pointer-events/遮挡/顶层阻挡/虚拟行回收。
  interactable: Object.freeze([
    'detached', 'paint-hidden', 'aria-hidden', 'offscreen', 'clipped',
    'pointer-events-none', 'occluded', 'blocking-layer', 'recycled-row',
  ]),
});

const LAYER_RANK = Object.freeze({ base: 0, 'fixed-sticky': 1, floating: 2, blocking: 3, 'top-layer': 4 });

function rectOf(node) {
  if (!node || typeof node !== 'object') return null;
  const source = node.bounds || node.rect || null;
  if (!source || typeof source !== 'object') return null;
  const x = Number(source.x);
  const y = Number(source.y);
  const width = Number(source.width != null ? source.width : source.w);
  const height = Number(source.height != null ? source.height : source.h);
  if (![x, y, width, height].every((value) => Number.isFinite(value))) return null;
  return { x, y, width, height };
}

export function rectArea(rect) {
  if (!rect) return 0;
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

function intersects(a, b) {
  if (!a || !b) return false;
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function overlapArea(a, b) {
  if (!intersects(a, b)) return 0;
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return Math.max(0, width) * Math.max(0, height);
}

/** 视口外判定：与 vom-weights 既有口径完全一致（只按矩形）。 */
export function isOffscreenNode(node) {
  const rect = rectOf(node) || {};
  // 兼容 page-lib 的 rect {x,y,w,h}
  const x = Number(rect.x != null ? rect.x : node && node.rect && node.rect.x) || 0;
  const y = Number(rect.y != null ? rect.y : node && node.rect && node.rect.y) || 0;
  const width = Number(rect.width != null ? rect.width : rect.w) || 0;
  const height = Number(rect.height != null ? rect.height : rect.h) || 0;
  return x < -1000 || y < -1000 || width <= 0 || height <= 0;
}

/** pointer-events: none 的统一判定（节点事实或 DOMSnapshot 事实都适用）。 */
export function isPointerTransparent(nodeOrFact) {
  if (!nodeOrFact || typeof nodeOrFact !== 'object') return false;
  if (String(nodeOrFact.pointerEvents || '').toLowerCase() === 'none') return true;
  if (nodeOrFact.hitTest === 'pointer-events-none') return true;
  const styles = nodeOrFact.styles && typeof nodeOrFact.styles === 'object' ? nodeOrFact.styles : null;
  return Boolean(styles && String(styles['pointer-events'] || '').toLowerCase() === 'none');
}

/** DOMSnapshot/AX 事实的可见性（blocking-layers 原口径：必须显式 visible:true）。 */
export function isFactVisible(fact) {
  return Boolean(fact && fact.visible === true);
}

/** 页面侧 paint 事实：paintVisible=false 或 display/visibility/opacity 时给出原因。 */
export function paintHiddenReason(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.paintVisible === false && node.hiddenReason) return String(node.hiddenReason);
  const display = String(node.display || (node.styles && node.styles.display) || '').toLowerCase();
  if (display === 'none') return 'display-none';
  const visibility = String(node.styleVisibility || node.visibility || (node.styles && node.styles.visibility) || '').toLowerCase();
  if (visibility === 'hidden' || visibility === 'collapse') return 'visibility-hidden';
  const opacity = String(node.styleOpacity != null ? node.styleOpacity : (node.opacity == null ? '' : node.opacity)).trim();
  if (opacity && Number(opacity) === 0) return 'opacity-zero';
  if (node.paintVisible === false) return node.hiddenReason ? String(node.hiddenReason) : 'paint-hidden';
  return null;
}

/**
 * 兼容 vom-weights 的既有口径（分值必须零漂移）：
 *   - offscreen：矩形越界/零面积；
 *   - hiddenBlocked：clickable===false 且 hitTest==='blocked'；
 *   - hiddenAria：visible===false 或 ariaHidden===true；
 *   - occluded：hitTest==='blocked'。
 */
export function visibilityFlags(node) {
  const hitTest = String((node && node.hitTest) || '');
  return {
    offscreen: isOffscreenNode(node),
    hiddenBlocked: Boolean(node && node.clickable === false && hitTest === 'blocked'),
    hiddenAria: Boolean(node && (node.visible === false || node.ariaHidden === true)),
    occluded: hitTest === 'blocked',
    pointerTransparent: isPointerTransparent(node),
    paintHidden: Boolean(paintHiddenReason(node)),
  };
}

function layerInfoOf(node) {
  const kind = String((node && (node.layerKind || node.kind)) || '');
  return {
    kind: kind || null,
    rank: LAYER_RANK[kind] != null ? LAYER_RANK[kind] : kind ? 2 : 0,
    zIndex: Number.isFinite(Number(node && node.zIndex)) ? Number(node.zIndex) : null,
    blocking: Boolean(node && node.blocking === true),
    paintOrder: Number.isFinite(Number(node && node.paintOrder)) ? Number(node.paintOrder) : null,
  };
}

/** paint-order 比较：层种类 → z-index → 页面 paintOrder；返回负数表示 a 先画。 */
export function comparePaintOrder(a, b) {
  const left = layerInfoOf(a);
  const right = layerInfoOf(b);
  if (left.rank !== right.rank) return left.rank - right.rank;
  const leftZ = left.zIndex == null ? 0 : left.zIndex;
  const rightZ = right.zIndex == null ? 0 : right.zIndex;
  if (leftZ !== rightZ) return leftZ - rightZ;
  const leftP = left.paintOrder == null ? 0 : left.paintOrder;
  const rightP = right.paintOrder == null ? 0 : right.paintOrder;
  if (leftP !== rightP) return leftP - rightP;
  return 0;
}

/**
 * 统一可见性判定。
 * @param {object} node 节点事实（页面侧 + 扩展侧均可）
 * @param {{occluder?:{occluderId?:string, coverage?:number}|null}} [options]
 * @returns {{version:number, paintable:boolean, visible:boolean, interactive:boolean,
 *   pointerEvents:string|null, reasons:string[], reason:string|null,
 *   offscreen:boolean, clipped:boolean, occluded:boolean, blocked:boolean,
 *   paint:{layerKind:string|null, zIndex:number|null, blocking:boolean, paintOrder:number|null}}}
 */
export function evaluateVisibility(node, options = {}) {
  const input = node && typeof node === 'object' ? node : {};
  const reasons = [];
  const push = (reason) => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  if (input.detached === true) push('detached');
  const hiddenReason = paintHiddenReason(input);
  if (hiddenReason || input.visible === false) push('paint-hidden');
  if (input.ariaHidden === true) push('aria-hidden');
  const offscreen = input.offscreen === true || input.inViewport === false || input.hitTest === 'offscreen' || isOffscreenNode(input);
  if (offscreen) push('offscreen');
  const clipped = input.clipped === true || input.clip === true || (input.clippedBy != null && input.clippedBy !== '');
  if (clipped) push('clipped');
  const pointerEvents = input.pointerEvents == null
    ? (input.styles && input.styles['pointer-events'] != null ? String(input.styles['pointer-events']) : null)
    : String(input.pointerEvents);
  if (isPointerTransparent(input)) push('pointer-events-none');
  const hitTest = String(input.hitTest || '');
  const blocked = hitTest === 'blocked';
  if (blocked) push('occluded');
  const occluder = options.occluder || null;
  if (occluder && occluder.occluderId != null && !blocked) push('occluded');
  if (input.underBlockingLayer != null && input.underBlockingLayer !== false) push('blocking-layer');
  const anchor = input.anchor && typeof input.anchor === 'object' ? input.anchor : null;
  if (anchor && anchor.recycled === true) push('recycled-row');
  const hardHidden = reasons.some((reason) => GATE_MODES.paintable.includes(reason));
  const paint = layerInfoOf(input);
  const ordered = VISIBILITY_REASONS.filter((reason) => reasons.includes(reason));
  return {
    version: VOM_VISIBILITY_VERSION,
    paintable: !hardHidden,
    visible: !reasons.some((reason) => GATE_MODES.visible.includes(reason)),
    interactive: !reasons.some((reason) => GATE_MODES.interactable.includes(reason)),
    pointerEvents,
    offscreen,
    clipped,
    occluded: reasons.includes('occluded') || reasons.includes('blocking-layer'),
    blocked,
    paint,
    reasons: ordered,
    reason: ordered[0] || null,
  };
}

function nodeIdOf(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.id != null && node.id !== '') return String(node.id);
  if (node.ref) return String(node.ref);
  if (node.stableRef) return String(node.stableRef);
  return null;
}

function ancestryOf(node) {
  const ids = new Set();
  if (!node || typeof node !== 'object') return ids;
  if (Array.isArray(node.ancestorIds)) for (const id of node.ancestorIds) if (id != null) ids.add(String(id));
  if (Array.isArray(node.ancestors)) {
    for (const item of node.ancestors) {
      if (!item) continue;
      const id = item.ref || item.id;
      if (id) ids.add(String(id));
    }
  }
  return ids;
}

/**
 * 用 paint-order + 层模型 + 几何求遮挡者。
 * 规则：只在“更高 paint-order 的阻挡层/顶层节点”里找；祖先/后代互相覆盖不算遮挡
 * （父容器本来就包住子元素，页面 hit-test 会把子元素判成可命中）；覆盖率 >= threshold 才记。
 * @param {Array} nodes 节点事实（需要 id/ref + bounds/rect）
 * @param {{layers?:Array, threshold?:number, limit?:number}} [options]
 * @returns {{byId:Map<string,{occluderId:string, coverage:number}>, count:number, checked:number}}
 */
export function resolveOcclusion(nodes, options = {}) {
  const max = Math.min(Math.max(Number(options.limit) || 600, 1), 4000);
  const threshold = Math.min(Math.max(Number(options.threshold) || 0.85, 0.3), 1);
  const list = (Array.isArray(nodes) ? nodes : []).slice(0, max);
  const byId = new Map();
  const candidates = [];
  for (const node of list) {
    const rect = rectOf(node);
    if (!rect) continue;
    const id = nodeIdOf(node);
    if (!id) continue;
    const info = layerInfoOf(node);
    const explicitBlocking = node.blocking === true || node.layerKind === 'blocking' || node.layerKind === 'top-layer';
    const dialogRole = ['dialog', 'alertdialog', 'overlay', 'mask', 'backdrop'].includes(String(node.role || '').toLowerCase());
    if (explicitBlocking || dialogRole) {
      candidates.push({ id, rect, node, rank: info.rank, zIndex: info.zIndex, paintOrder: info.paintOrder });
    }
  }
  // 层模型里的阻挡层也参与遮挡（AX/DOMSnapshot 交叉检查得到的层）。
  for (const layer of Array.isArray(options.layers) ? options.layers : []) {
    if (!layer || layer.blocking !== true) continue;
    const rect = rectOf(layer);
    if (!rect) continue;
    const id = nodeIdOf(layer);
    if (!id) continue;
    if (candidates.some((item) => item.id === id)) continue;
    const info = layerInfoOf(layer);
    candidates.push({ id, rect, node: layer, rank: info.rank, zIndex: info.zIndex, paintOrder: info.paintOrder });
  }
  candidates.sort((a, b) => (b.rank - a.rank) || ((b.zIndex || 0) - (a.zIndex || 0)) || ((b.paintOrder || 0) - (a.paintOrder || 0)));
  let checked = 0;
  for (const node of list) {
    const id = nodeIdOf(node);
    if (!id) continue;
    if (node.underBlockingLayer === true) {
      const blocker = candidates.find((item) => item.id !== id && !ancestryOf(node).has(item.id));
      if (blocker) byId.set(id, { occluderId: blocker.id, coverage: 1 });
      continue;
    }
    const rect = rectOf(node);
    if (!rect) continue;
    const area = rectArea(rect);
    if (!(area > 0)) continue;
    const ancestry = ancestryOf(node);
    checked += 1;
    for (const candidate of candidates) {
      if (candidate.id === id) continue;
      if (ancestry.has(candidate.id)) continue;
      const coverage = overlapArea(rect, candidate.rect) / area;
      if (coverage < threshold) continue;
      byId.set(id, { occluderId: candidate.id, coverage: Math.round(coverage * 1000) / 1000 });
      break;
    }
  }
  return { byId, count: byId.size, checked };
}

/**
 * 按 gate 模式过滤。返回保留节点、丢弃节点与按原因计数，供 observe 诊断使用。
 * @param {Array} nodes
 * @param {{mode?:'paintable'|'visible'|'interactable', occlusion?:{byId:Map}}} [options]
 */
export function applyVisibilityGate(nodes, { mode = 'paintable', occlusion = null } = {}) {
  const rules = GATE_MODES[mode] || GATE_MODES.paintable;
  const occById = occlusion && occlusion.byId instanceof Map ? occlusion.byId : new Map();
  const kept = [];
  const dropped = [];
  const byReason = {};
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const id = nodeIdOf(node) || ('n' + kept.length);
    const occluder = occById.get(id) || null;
    const verdict = evaluateVisibility(node, { occluder });
    const failed = verdict.reasons.filter((reason) => rules.includes(reason));
    if (failed.length) {
      const reason = failed[0];
      byReason[reason] = (byReason[reason] || 0) + 1;
      dropped.push({ id, reason, reasons: failed });
    } else {
      kept.push(node);
    }
  }
  const input = (Array.isArray(nodes) ? nodes : []).length;
  return {
    version: VOM_VISIBILITY_VERSION,
    mode,
    rules: rules.slice(),
    nodes: kept,
    kept: kept.length,
    dropped,
    counts: { input, kept: kept.length, dropped: dropped.length, byReason },
  };
}

/** gate 结果的紧凑摘要（observe 输出的 vomVisibility）。 */
export function summarizeVisibilityGate(result) {
  const counts = result && result.counts ? result.counts : { input: 0, kept: 0, dropped: 0, byReason: {} };
  return {
    version: VOM_VISIBILITY_VERSION,
    mode: result && result.mode ? result.mode : 'paintable',
    input: counts.input,
    kept: counts.kept,
    dropped: counts.dropped,
    byReason: { ...(counts.byReason || {}) },
  };
}

/** payload 节点上的紧凑 visibility 字段：保留判定与证据，不放大观测体积。 */
export function visibilityPayload(node, options = {}) {
  const verdict = evaluateVisibility(node, options);
  return {
    version: verdict.version,
    paintable: verdict.paintable,
    visible: verdict.visible,
    interactive: verdict.interactive,
    pointer: verdict.pointerEvents,
    paint: verdict.paint,
    reason: verdict.reason,
    reasons: verdict.reasons,
    ...(options.occluder && options.occluder.occluderId != null && verdict.occluded
      ? { occluder: { id: String(options.occluder.occluderId), coverage: options.occluder.coverage == null ? null : options.occluder.coverage } }
      : {}),
  };
}

export function visibilityVersion() {
  return VOM_VISIBILITY_VERSION;
}
