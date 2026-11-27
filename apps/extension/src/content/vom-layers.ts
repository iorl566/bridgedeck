// src/content/vom-layers.ts —— observe 的 paint-order 分层事实（L2 带：modal / mask）。
//
// 源语义（只读参考）：
// - extension/src/lib/blocking-layers.js 的 computeLayerBands（dialog/modal 角色与“铺满视口的
//   固定/粘性定位元素”作为 L2 带，输出 kind=modal/mask + coverage + paintOrder + members）；
// - extension/src/lib/vom-layers.js 的 deriveLayers（排序/层级归一：base → fixed-sticky →
//   floating → blocking → top-layer）→ 已移植到 packages/vom/src/layers.ts（单一实现）。
//
// 没有 CDP/DOMSnapshot：几何与样式全部来自 DOM + computed style；coverage 用视口面积做分母，
// 阈值与 JS 基线一致（非 modal 元素 coverage ≥ 0.2 才算一个带）。
// 本层只报告“页面看起来有哪些层”，不改变动作层的遮挡策略（35b 的 hitTest 在 vom-deep.ts）。

import { deriveLayers } from '../../../../packages/vom/src/layers.ts';
import type { LayerFact } from '../../../../packages/vom/src/types.ts';
import { isVisible, roleOfElement, styleOf, tagOf, type DomEnvironment, type ElementLike } from './dom.ts';
import { normalizeText } from './dom.ts';

/** 非 modal 元素成为 L2 带所需的最小覆盖率（与 JS 基线一致）。 */
export const VOM_LAYER_MIN_COVERAGE = 0.2;

/** L2 带数量上限（与 JS computeLayerBands 默认一致）。 */
export const VOM_LAYER_BAND_LIMIT = 3;

/** 覆盖视口的容差（CSS px）。 */
export const VOM_LAYER_VIEWPORT_TOLERANCE = 2;

/** L2 带种类。 */
export type VomLayerKind = 'modal' | 'mask';

/** L2 带（observe 的 layers 项；字段与 JS layerFacts 同形）。 */
export interface VomLayerBand {
  level: 'L2';
  role: string | null;
  name: string;
  backendNodeId: number | null;
  bounds: { x: number; y: number; width: number; height: number };
  /** 覆盖视口面积比例（0..1，保留三位小数）。 */
  coverage: number;
  kind: VomLayerKind;
  /** DOM 顺序（越大越靠后绘制；整数）。 */
  paintOrder: number;
  /** 该带覆盖了多少个候选层（paintOrder ≥ 本带的数量）。 */
  members: number;
  spansViewport: boolean;
  /** deriveLayers 归一后的绘制顺序（0 = base）。 */
  index: number;
  /** deriveLayers 归一后的层种类（base/fixed-sticky/floating/blocking/top-layer）。 */
  layerKind: string;
  zIndex: number | null;
  blocking: boolean;
  topLayer: string | null;
}

interface LayerCandidate {
  el: ElementLike;
  role: string | null;
  name: string;
  bounds: { x: number; y: number; width: number; height: number };
  coverage: number;
  kind: VomLayerKind;
  paintOrder: number;
  spansViewport: boolean;
  zIndex: number | null;
  position: string;
  topLayer: string | null;
  pointerEvents: string;
}

const DIALOG_ROLES: ReadonlySet<string> = new Set(['dialog', 'alertdialog']);

function viewportOf(env: DomEnvironment): { width: number; height: number } {
  return {
    width: Number(env.window.innerWidth) || 0,
    height: Number(env.window.innerHeight) || 0,
  };
}

function zIndexOf(raw: string | undefined): number | null {
  const text = String(raw ?? '').trim();
  if (!/^-?\d+$/.test(text)) return null;
  return Number(text);
}

function spansViewport(
  bounds: { x: number; y: number; width: number; height: number },
  viewport: { width: number; height: number },
  tolerance: number,
): boolean {
  const t = Math.max(0, tolerance);
  return bounds.x <= t
    && bounds.y <= t
    && bounds.x + bounds.width >= viewport.width - t
    && bounds.y + bounds.height >= viewport.height - t;
}

/**
 * 从 DOM 事实推导 L2 带（modal / mask）。
 *
 * 候选：role=dialog/alertdialog 的可见元素（modal，不受覆盖率门槛限制），
 * 或“铺满视口的 fixed/sticky/absolute 且覆盖 ≥ 20%”的元素（mask）。
 * 被 pointer-events:none 的面板不算遮挡带（与 JS isPointerTransparent 口径一致）。
 */
export function collectLayerBands(env: DomEnvironment, collected: ReadonlyArray<{ el: ElementLike; order: number }>): LayerCandidate[] {
  const viewport = viewportOf(env);
  const viewportArea = viewport.width * viewport.height;
  const candidates: LayerCandidate[] = [];
  for (const item of collected) {
    const el = item.el;
    const tag = tagOf(el);
    if (tag === 'HTML' || tag === 'BODY') continue;
    if (!isVisible(env, el)) continue;
    const style = styleOf(env, el) as {
      position?: string;
      zIndex?: string;
      pointerEvents?: string;
      topLayer?: string;
    };
    const pointerEvents = String(style.pointerEvents ?? 'auto');
    if (pointerEvents === 'none') continue;
    let rect: { x: number; y: number; width: number; height: number };
    try {
      const box = el.getBoundingClientRect();
      rect = {
        x: Number(box.left) || 0,
        y: Number(box.top) || 0,
        width: Math.abs(Number(box.width) || 0),
        height: Math.abs(Number(box.height) || 0),
      };
    } catch {
      continue;
    }
    if (!(rect.width > 0 && rect.height > 0)) continue;
    const coverage = viewportArea > 0 ? (rect.width * rect.height) / viewportArea : 0;
    if (!(coverage > 0)) continue;
    const role = roleOfElement(el);
    const modalRole = role ? DIALOG_ROLES.has(role) : false;
    const position = String(style.position ?? '');
    const positioned = position === 'fixed' || position === 'sticky' || position === 'absolute';
    const spans = spansViewport(rect, viewport, VOM_LAYER_VIEWPORT_TOLERANCE);
    if (!modalRole && !(spans && positioned)) continue;
    if (!modalRole && coverage < VOM_LAYER_MIN_COVERAGE) continue;
    const topLayer = String(style.topLayer ?? '').toLowerCase() || null;
    candidates.push({
      el,
      role,
      name: normalizeText(el.getAttribute('aria-label') ?? el.textContent).slice(0, 100),
      bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      coverage: Math.round(coverage * 1000) / 1000,
      kind: modalRole ? 'modal' : 'mask',
      paintOrder: item.order,
      spansViewport: spans,
      zIndex: zIndexOf(style.zIndex),
      position,
      topLayer: topLayer === 'modal-dialog' || topLayer === 'role-dialog' || topLayer === 'dialog' ? topLayer : null,
      pointerEvents,
    });
  }
  return candidates;
}

/**
 * L2 带 → observe 的 layers 数组（按覆盖率降序，同覆盖率按 DOM 顺序降序）。
 *
 * @param limit 带数量上限（默认 3，与 JS computeLayerBands 一致）
 */
export function buildLayerFacts(
  env: DomEnvironment,
  collected: ReadonlyArray<{ el: ElementLike; order: number }>,
  limit = VOM_LAYER_BAND_LIMIT,
): VomLayerBand[] {
  const candidates = collectLayerBands(env, collected);
  if (!candidates.length) return [];
  const sorted = candidates.slice().sort((left, right) => (right.coverage - left.coverage) || (right.paintOrder - left.paintOrder));
  const bands: VomLayerBand[] = [];
  const max = Math.min(Math.max(Number(limit) || VOM_LAYER_BAND_LIMIT, 1), 6);
  for (const winner of sorted) {
    if (bands.length >= max) break;
    const members = candidates.filter((item) => item.paintOrder >= winner.paintOrder).length;
    bands.push({
      level: 'L2',
      role: winner.role || (winner.kind === 'modal' ? 'dialog' : 'overlay'),
      name: winner.name,
      backendNodeId: Number.isInteger(winner.paintOrder) ? winner.paintOrder + 1 : null,
      bounds: { ...winner.bounds },
      coverage: winner.coverage,
      kind: winner.kind,
      paintOrder: winner.paintOrder,
      members,
      spansViewport: winner.spansViewport,
      index: 0,
      layerKind: winner.kind,
      zIndex: winner.zIndex,
      blocking: winner.kind === 'modal',
      topLayer: winner.topLayer,
    });
  }
  // 用 packages/vom 的有序层模型回填 index/layerKind/zIndex/blocking/topLayer（单一实现）。
  const facts: LayerFact[] = bands.map((band) => ({
    rect: band.bounds,
    role: band.role,
    name: band.name,
    tag: null,
    zIndex: band.zIndex,
    position: null,
    topLayer: band.kind === 'modal' ? 'role-dialog' : null,
    coverage: band.coverage,
    pointerEvents: null,
    paintOrder: band.paintOrder,
    kind: band.kind,
    level: band.level,
  }));
  let model: ReturnType<typeof deriveLayers>;
  try {
    model = deriveLayers(facts);
  } catch {
    return bands;
  }
  const bySource = new Map<number, { index: number; kind: string; zIndex: number | null; blocking: boolean; topLayer: string | null }>();
  for (const layer of model.layers) {
    if (layer.sourceIndex < 0) continue;
    bySource.set(layer.sourceIndex, {
      index: layer.index,
      kind: layer.kind,
      zIndex: layer.zIndex,
      blocking: layer.blocking === true,
      topLayer: layer.topLayer,
    });
  }
  bands.forEach((band, sourceIndex) => {
    const mapped = bySource.get(sourceIndex);
    if (!mapped) return;
    band.index = mapped.index;
    band.layerKind = mapped.kind;
    band.zIndex = mapped.zIndex;
    band.blocking = mapped.blocking;
    band.topLayer = mapped.topLayer;
  });
  return bands;
}
