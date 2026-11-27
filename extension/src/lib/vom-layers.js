// lib/vom-layers.js —— 从 DOM/AX 事实推导有序层模型（纯函数，可单测）。
//
// 层种类（后 → 前）：base → fixed-sticky → floating → blocking → top-layer。
// 输出 { index, kind, zIndex, blocking, rect?, level?, role?, name?, coverage?, topLayer? }：
//   - index：绘制顺序（0 = 文档基底，越大越靠前）；
//   - zIndex：computed z-index，未知为 null（不是 0）；
//   - blocking：是否阻挡指针（dialog/modal/遮罩），例如 popover 的 top-layer 不算阻挡；
//   - rect：DIP 矩形（无几何事实时为 null）。
// 输入兼容阻塞层既有输出（computeBlockingLayers），也接受页面侧 layerStackFacts 或原始事实对象。

export const VOM_LAYERS_VERSION = 1;

export const LAYER_KINDS = Object.freeze(['base', 'fixed-sticky', 'floating', 'blocking', 'top-layer']);

const KIND_RANK = Object.freeze({ base: 0, 'fixed-sticky': 1, floating: 2, blocking: 3, 'top-layer': 4 });
const DIALOG_ROLES = new Set(['dialog', 'alertdialog']);
const BLOCKING_ROLES = new Set(['overlay', 'mask', 'backdrop']);
const TOP_LAYER_VALUES = new Set(['modal-dialog', 'popover', 'fullscreen', 'dialog', 'role-dialog']);
const BLOCKING_KINDS = new Set(['mask', 'overlay', 'blocking', 'modal']);

function rectOf(item) {
  if (!item || typeof item !== 'object') return null;
  const source = item.rect || item.bounds || null;
  if (!source) return null;
  const x = Number(source.x);
  const y = Number(source.y);
  const width = Number(source.width != null ? source.width : source.w);
  const height = Number(source.height != null ? source.height : source.h);
  if (![x, y, width, height].every((value) => Number.isFinite(value))) return null;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

function zIndexOf(value) {
  if (Number.isFinite(value)) return Number(value);
  const text = String(value == null ? '' : value).trim();
  return /^-?\d+$/.test(text) ? Number(text) : null;
}

function normalizeTopLayer(value) {
  const text = String(value || '').toLowerCase();
  if (!text || text === 'null' || text === 'false') return null;
  return TOP_LAYER_VALUES.has(text) ? text : null;
}

function positionOf(item) {
  const style = item && item.styles && typeof item.styles === 'object' ? item.styles : {};
  return String((item && item.position) || style.position || '').toLowerCase();
}

/** 单个层事实 → 归一化候选（不含 index）。 */
export function normalizeLayer(item, sourceIndex = -1) {
  if (!item || typeof item !== 'object') return null;
  const role = String(item.role || '').toLowerCase();
  const kindText = String(item.layerKind || item.kind || '').toLowerCase();
  const position = positionOf(item);
  const zIndex = zIndexOf(item.zIndex != null ? item.zIndex : item.styles && item.styles['z-index']);
  const topLayer = normalizeTopLayer(item.topLayer);
  const coverage = Number.isFinite(Number(item.coverage)) ? Number(item.coverage) : null;
  const dialog = DIALOG_ROLES.has(role) || kindText === 'modal' || topLayer === 'modal-dialog' || topLayer === 'role-dialog' || topLayer === 'dialog';
  const blocking = item.blocking === true
    || dialog
    || BLOCKING_KINDS.has(kindText)
    || BLOCKING_ROLES.has(role)
    || (position === 'fixed' && coverage != null && coverage >= 0.9);
  let kind;
  if (topLayer || dialog) kind = 'top-layer';
  else if (blocking || BLOCKING_KINDS.has(kindText)) kind = 'blocking';
  else if (zIndex != null && zIndex !== 0) kind = 'floating';
  else if (position === 'fixed' || position === 'sticky') kind = 'fixed-sticky';
  else kind = 'floating';
  return {
    kind,
    zIndex,
    blocking,
    rect: rectOf(item),
    level: typeof item.level === 'string' && item.level ? item.level : 'L2',
    role: role || null,
    name: item.name == null ? null : String(item.name).slice(0, 80),
    id: item.id == null ? null : String(item.id).slice(0, 80),
    tag: item.tag == null ? null : String(item.tag).toLowerCase(),
    backendNodeId: Number.isInteger(Number(item.backendNodeId)) && Number(item.backendNodeId) > 0 ? Number(item.backendNodeId) : null,
    coverage,
    position: position || null,
    topLayer,
    pointerEvents: item.pointerEvents == null ? null : String(item.pointerEvents),
    paintOrder: Number.isFinite(Number(item.paintOrder)) ? Number(item.paintOrder) : 0,
    sourceIndex,
  };
}

function baseLayer() {
  return {
    index: 0,
    kind: 'base',
    zIndex: 0,
    blocking: false,
    rect: null,
    level: 'L1',
    role: null,
    name: null,
    id: null,
    tag: null,
    backendNodeId: null,
    coverage: null,
    position: null,
    topLayer: null,
    pointerEvents: null,
    paintOrder: 0,
    sourceIndex: -1,
  };
}

function sortValue(layer) {
  return [
    KIND_RANK[layer.kind] != null ? KIND_RANK[layer.kind] : 9,
    layer.zIndex == null ? 0 : layer.zIndex,
    layer.paintOrder || 0,
    layer.sourceIndex,
  ];
}

function compareLayers(a, b) {
  const left = sortValue(a);
  const right = sortValue(b);
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

/**
 * 事实 → 有序层模型（后 → 前）。
 * @param {Array|{layers?:Array}} input 阻塞层/页面侧层事实
 * @param {{includeBase?: boolean, limit?: number}} options
 */
export function deriveLayers(input, { includeBase = true, limit = 24 } = {}) {
  const list = Array.isArray(input) ? input : (input && Array.isArray(input.layers) ? input.layers : []);
  const max = Math.min(Math.max(Number(limit) || 24, 1), 100);
  const candidates = [];
  list.forEach((item, sourceIndex) => {
    const normalized = normalizeLayer(item, sourceIndex);
    if (normalized) candidates.push(normalized);
  });
  candidates.sort(compareLayers);
  const layers = [];
  if (includeBase) layers.push(baseLayer());
  for (const item of candidates) {
    if (layers.length >= max) break;
    item.index = layers.length;
    layers.push(item);
  }
  const counts = {};
  for (const layer of layers) counts[layer.kind] = (counts[layer.kind] || 0) + 1;
  return {
    version: VOM_LAYERS_VERSION,
    layers,
    counts: { total: layers.length, byKind: counts },
    truncated: candidates.length + (includeBase ? 1 : 0) > max,
  };
}

/** 图层可读片段，例如 "top-layer z=1000 blocking"。 */
export function describeLayer(layer) {
  if (!layer || typeof layer !== 'object') return '';
  const parts = [];
  if (layer.kind && layer.kind !== 'base') parts.push(String(layer.kind));
  if (Number.isFinite(Number(layer.zIndex)) && layer.zIndex !== null && layer.zIndex !== 0) parts.push('z=' + Number(layer.zIndex));
  if (layer.blocking === true) parts.push('blocking');
  return parts.join(' ');
}
