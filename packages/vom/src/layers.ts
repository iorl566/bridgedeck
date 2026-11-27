// packages/vom/src/layers.ts —— 从 DOM/AX 事实推导有序层模型（类型化移植）。
//
// 源：extension/src/lib/vom-layers.js（行为逐字段等价的基线，差分测试对拍）。
//
// 层种类（后 → 前）：base → fixed-sticky → floating → blocking → top-layer。
// 输出 { index, kind, zIndex, blocking, rect?, level?, role?, name?, coverage?, topLayer? }：
//   - index：绘制顺序（0 = 文档基底，越大越靠前）；
//   - zIndex：computed z-index，未知为 null（不是 0）；
//   - blocking：是否阻挡指针（dialog/modal/遮罩），例如 popover 的 top-layer 不算阻挡；
//   - rect：DIP 矩形（无几何事实时为 null）。
// 输入兼容阻塞层既有输出（computeBlockingLayers），也接受页面侧 layerStackFacts 或原始事实对象。
//
// 排序键是 [kind 等级, zIndex, paintOrder, 源顺序]，与 JS 基线逐项一致；稳定排序依赖
// 引擎 Array.prototype.sort 的稳定性（Node/浏览器规范均已保证）。

import type {
  DeriveLayersOptions,
  Layer,
  LayerCandidate,
  LayerCounts,
  LayerFact,
  LayerInput,
  LayerKind,
  LayerModel,
  LayerRect,
  LayerRectInput,
} from './types.ts';

/** 层模型结构版本。 */
export const VOM_LAYERS_VERSION = 1;

/** 层种类（后 → 前，顺序即 KIND_RANK 顺序）。 */
export const LAYER_KINDS: readonly LayerKind[] = Object.freeze([
  'base', 'fixed-sticky', 'floating', 'blocking', 'top-layer',
]);

const KIND_RANK: Readonly<Record<LayerKind, number>> = Object.freeze({
  base: 0,
  'fixed-sticky': 1,
  floating: 2,
  blocking: 3,
  'top-layer': 4,
});
const DIALOG_ROLES: ReadonlySet<string> = new Set(['dialog', 'alertdialog']);
const BLOCKING_ROLES: ReadonlySet<string> = new Set(['overlay', 'mask', 'backdrop']);
const TOP_LAYER_VALUES: ReadonlySet<string> = new Set(['modal-dialog', 'popover', 'fullscreen', 'dialog', 'role-dialog']);
const BLOCKING_KINDS: ReadonlySet<string> = new Set(['mask', 'overlay', 'blocking', 'modal']);

/** 归一化矩形：四个分量都必须是有限数，输出四舍五入整数。 */
function rectOf(item: LayerFact | null | undefined): LayerRect | null {
  if (!item || typeof item !== 'object') return null;
  const source: LayerRectInput | null = item.rect || item.bounds || null;
  if (!source) return null;
  const x = Number(source.x);
  const y = Number(source.y);
  const width = Number(source.width != null ? source.width : source.w);
  const height = Number(source.height != null ? source.height : source.h);
  if (![x, y, width, height].every((value) => Number.isFinite(value))) return null;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

/**
 * zIndex 归一：有限数字直接用；字符串去空白后必须整体是整数（允许负号）；
 * 其余（'10px'、'auto'、''、null、NaN）返回 null —— 注意 null 不等于 0。
 */
function zIndexOf(value: unknown): number | null {
  if (Number.isFinite(value)) return Number(value);
  const text = String(value == null ? '' : value).trim();
  return /^-?\d+$/.test(text) ? Number(text) : null;
}

/** top-layer 语义归一：只接受已知枚举（大小写不敏感），'null'/'false' 视为无。 */
function normalizeTopLayer(value: unknown): string | null {
  const text = String(value || '').toLowerCase();
  if (!text || text === 'null' || text === 'false') return null;
  return TOP_LAYER_VALUES.has(text) ? text : null;
}

/** position：兼容 item.position 与 item.styles.position。 */
function positionOf(item: LayerFact | null | undefined): string {
  const style = item && item.styles && typeof item.styles === 'object' ? item.styles : null;
  return String((item && item.position) || (style && style.position) || '').toLowerCase();
}

/** 单个层事实 → 归一化候选（不含 index）。 */
export function normalizeLayer(
  item: LayerFact | null | undefined,
  sourceIndex = -1,
): LayerCandidate | null {
  if (!item || typeof item !== 'object') return null;
  const role = String(item.role || '').toLowerCase();
  const kindText = String(item.layerKind || item.kind || '').toLowerCase();
  const position = positionOf(item);
  const zIndex = zIndexOf(item.zIndex != null ? item.zIndex : item.styles && item.styles['z-index']);
  const topLayer = normalizeTopLayer(item.topLayer);
  const coverage = Number.isFinite(Number(item.coverage)) ? Number(item.coverage) : null;
  const dialog = DIALOG_ROLES.has(role)
    || kindText === 'modal'
    || topLayer === 'modal-dialog'
    || topLayer === 'role-dialog'
    || topLayer === 'dialog';
  const blocking = item.blocking === true
    || dialog
    || BLOCKING_KINDS.has(kindText)
    || BLOCKING_ROLES.has(role)
    || (position === 'fixed' && coverage != null && coverage >= 0.9);
  let kind: LayerKind;
  if (topLayer || dialog) kind = 'top-layer';
  else if (blocking || BLOCKING_KINDS.has(kindText)) kind = 'blocking';
  else if (zIndex != null && zIndex !== 0) kind = 'floating';
  else if (position === 'fixed' || position === 'sticky') kind = 'fixed-sticky';
  else kind = 'floating';
  const backendNodeIdValue = Number(item.backendNodeId);
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
    backendNodeId: Number.isInteger(backendNodeIdValue) && backendNodeIdValue > 0 ? backendNodeIdValue : null,
    coverage,
    position: position || null,
    topLayer,
    pointerEvents: item.pointerEvents == null ? null : String(item.pointerEvents),
    paintOrder: Number.isFinite(Number(item.paintOrder)) ? Number(item.paintOrder) : 0,
    sourceIndex,
  };
}

/** 文档基底层（index 0，永远是底）。 */
function baseLayer(): Layer {
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

/** 排序键：[kind 等级, zIndex, paintOrder, 源顺序]。 */
function sortValue(layer: LayerCandidate): readonly number[] {
  return [
    KIND_RANK[layer.kind] != null ? KIND_RANK[layer.kind] : 9,
    layer.zIndex == null ? 0 : layer.zIndex,
    layer.paintOrder || 0,
    layer.sourceIndex,
  ];
}

function compareLayers(a: LayerCandidate, b: LayerCandidate): number {
  const left = sortValue(a);
  const right = sortValue(b);
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    if (leftValue !== rightValue) return leftValue - rightValue;
  }
  return 0;
}

/** 输入归一：数组直接用；{layers} 取字段；其余视为空。 */
function layerListOf(input: LayerInput): readonly LayerFact[] {
  if (Array.isArray(input)) return input as readonly LayerFact[];
  if (input && typeof input === 'object') {
    const layers = (input as { layers?: unknown }).layers;
    if (Array.isArray(layers)) return layers as readonly LayerFact[];
  }
  return [];
}

/** 事实 → 有序层模型（后 → 前）。 */
export function deriveLayers(
  input: LayerInput,
  options: DeriveLayersOptions = {},
): LayerModel {
  const includeBase = options.includeBase ?? true;
  const limit = options.limit ?? 24;
  const list = layerListOf(input);
  const max = Math.min(Math.max(Number(limit) || 24, 1), 100);
  const candidates: LayerCandidate[] = [];
  list.forEach((item, sourceIndex) => {
    const normalized = normalizeLayer(item, sourceIndex);
    if (normalized) candidates.push(normalized);
  });
  candidates.sort(compareLayers);
  const layers: Layer[] = [];
  if (includeBase) layers.push(baseLayer());
  for (const item of candidates) {
    if (layers.length >= max) break;
    layers.push({ index: layers.length, ...item });
  }
  const byKind: Partial<Record<LayerKind, number>> = {};
  for (const layer of layers) {
    byKind[layer.kind] = (byKind[layer.kind] || 0) + 1;
  }
  const counts: LayerCounts = { total: layers.length, byKind };
  return {
    version: VOM_LAYERS_VERSION,
    layers,
    counts,
    truncated: candidates.length + (includeBase ? 1 : 0) > max,
  };
}

/** 图层可读片段，例如 "top-layer z=1000 blocking"。 */
export function describeLayer(layer: Layer | LayerCandidate | null | undefined): string {
  if (!layer || typeof layer !== 'object') return '';
  const parts: string[] = [];
  if (layer.kind && layer.kind !== 'base') parts.push(String(layer.kind));
  const zIndex = layer.zIndex;
  if (Number.isFinite(Number(zIndex)) && zIndex !== null && zIndex !== 0) parts.push('z=' + Number(zIndex));
  if (layer.blocking === true) parts.push('blocking');
  return parts.join(' ');
}
