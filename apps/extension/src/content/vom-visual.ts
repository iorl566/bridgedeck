// src/content/vom-visual.ts —— VOM visualObjects：视觉区域（canvas/图片/自绘）+ 可动作 ref 身份。
//
// 源语义（只读参考）：
// - extension/injected/parts/27-visual-hit.part 的 visualScan（canvas/img/svg/自绘区域扫描 +
//   中心点命中过滤：只看“真的能被点到”的候选）；
// - extension/src/lib/visual-objects.js 的 buildVisualObjects（regions + refs 合并成统一清单）；
// - extension/src/tools/observation.js 的 stableRef 回填（视觉对象也要能按 stableRef 动作）。
//
// stableRef 语义与 background 的 `src/actions/observation.ts` 完全一致：
//   identity  = [cdpSessionId||'', documentId, frameId, tag, id||'', role||'', name||''].join('|')
//   identityKey = 'i-' + hash(identity)
//   stableRef  = 's-' + hash(identity + '#' + 同 identity 出现序号)
// 因此内容脚本产出的视觉 stableRef 与 ref 注册表里的 stableRef 天然对齐（同一次 observe）。
//
// 本文件只产出 JSON 事实，不做动作；坐标是视口 CSS px（与 @eN ref 的 rect 同口径）。

import { signatureHash } from '../refs/signature.ts';
import { normalizeText, roleOfElement, styleOf, tagOf, type DomEnvironment, type ElementLike } from './dom.ts';

/** 视觉区域（canvas 等）在 visualObjects 里的统一形状（与 JS 基线同形）。 */
export interface VomVisualRegionObject {
  kind: 'region';
  index: number;
  tag: string;
  id: string | null;
  rect: { x: number; y: number; width: number; height: number };
  /** stableRef 只对 ref 对象有意义（区域没有可动作身份）。 */
  stableRef?: string | null;
  backendNodeId?: number;
}

/** 可动作 ref 在 visualObjects 里的统一形状（与 JS 基线同形）。 */
export interface VomVisualRefObject {
  kind: 'ref';
  ref: string;
  role: string | null;
  name: string | null;
  rect: { x: number; y: number; width: number; height: number };
  /** 稳定引用（与 background ref 注册表同一算法；可跨 observe 认回同一节点）。 */
  stableRef?: string | null;
  /** TS 无 CDP：这是 DOM 顺序号派生 id（backendNodeSource=dom-order）。 */
  backendNodeId?: number;
}

/** visualObjects 清单项。 */
export type VomVisualObject = VomVisualRegionObject | VomVisualRefObject;

/** 扫描到的区域候选（internal：带元素引用，便于回填 backendNodeId）。 */
export interface VomVisualRegion {
  kind: 'region';
  index: number;
  tag: string;
  id: string | null;
  rect: { x: number; y: number; width: number; height: number };
}

/** visual-refs 投影（ref + 视口几何）。 */
export interface VomVisualRef {
  ref: string;
  role: string | null;
  name: string | null;
  rect: { x: number; y: number; width: number; height: number };
}

/** stableRef 计算上下文：必须与 background 侧同一 documentId/frameId。 */
export interface VisualStableRefContext {
  documentId: string;
  frameId?: number;
  cdpSessionId?: string | null;
}

/** 区域扫描上限（与 JS 页面库一致）。 */
export const VOM_VISUAL_REGION_LIMIT = 40;

function viewportOf(env: DomEnvironment): { width: number; height: number } {
  return {
    width: Number(env.window.innerWidth) || 0,
    height: Number(env.window.innerHeight) || 0,
  };
}

function rectOf(el: ElementLike): { x: number; y: number; width: number; height: number } {
  try {
    const rect = el.getBoundingClientRect();
    return {
      x: Number(rect?.left) || 0,
      y: Number(rect?.top) || 0,
      width: Math.abs(Number(rect?.width) || 0),
      height: Math.abs(Number(rect?.height) || 0),
    };
  } catch {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
}

function centerHitSelf(env: DomEnvironment, el: ElementLike, rect: { width: number; height: number }): boolean {
  const viewport = viewportOf(env);
  const box = (() => {
    try {
      return el.getBoundingClientRect();
    } catch {
      return null;
    }
  })();
  if (!box) return false;
  const left = Number(box.left) || 0;
  const top = Number(box.top) || 0;
  const cx = Math.min(viewport.width - 1, Math.max(0, left + rect.width / 2));
  const cy = Math.min(viewport.height - 1, Math.max(0, top + rect.height / 2));
  let top_: ElementLike | null = null;
  try {
    top_ = env.document.elementFromPoint?.(cx, cy) ?? null;
  } catch {
    top_ = null;
  }
  if (!top_) return false;
  if (top_ === el) return true;
  try {
    if (typeof el.contains === 'function' && el.contains(top_)) return true;
    if (typeof top_.contains === 'function' && top_.contains(el)) return true;
  } catch {
    return false;
  }
  return false;
}

/**
 * 视觉区域扫描：canvas / 图片 / svg / 自绘区域。
 *
 * 过滤条件与 JS 页面库一致：尺寸 ≥ 24×24、与视口相交、样式可见、中心点最上层是它/其后代/其祖先。
 * 只报告几何与类型，不判断内容是什么。
 */
export function scanVisualRegions(env: DomEnvironment, collected: ReadonlyArray<{ el: ElementLike }>): VomVisualRegion[] {
  const out: VomVisualRegion[] = [];
  const seen = new Set<ElementLike>();
  const viewport = viewportOf(env);
  const push = (el: ElementLike, kind: string): void => {
    if (!el || seen.has(el) || out.length >= VOM_VISUAL_REGION_LIMIT) return;
    const tag = tagOf(el).toLowerCase();
    if (tag === 'html' || tag === 'body') return;
    const rect = rectOf(el);
    if (rect.width < 24 || rect.height < 24) return;
    if (rect.y + rect.height <= 0 || rect.x + rect.width <= 0) return;
    if (rect.y >= viewport.height || rect.x >= viewport.width) return;
    const style = styleOf(env, el) as { visibility?: string; display?: string; opacity?: string };
    if (style.visibility === 'hidden' || style.display === 'none') return;
    if (Number(style.opacity) === 0) return;
    if (!centerHitSelf(env, el, rect)) return;
    seen.add(el);
    out.push({
      kind: 'region',
      index: out.length + 1,
      tag,
      id: el.id ? String(el.id) : null,
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    });
    void kind;
  };
  for (const item of collected) {
    if (tagOf(item.el) === 'CANVAS') push(item.el, 'canvas');
  }
  for (const item of collected) {
    const tag = tagOf(item.el);
    if (tag === 'IMG' || roleOfElement(item.el) === 'img') push(item.el, 'image');
  }
  for (const item of collected) {
    if (tagOf(item.el) === 'SVG') push(item.el, 'vector');
  }
  // 自绘区域：有背景图、自身几乎没有文本、面积够大（canvas 类控件的常见形态）。
  for (const item of collected) {
    if (out.length >= VOM_VISUAL_REGION_LIMIT) break;
    const el = item.el;
    const tag = tagOf(el);
    if (tag !== 'DIV' && tag !== 'SECTION' && tag !== 'LI') continue;
    if (seen.has(el)) continue;
    const style = styleOf(env, el) as { backgroundImage?: string };
    const backgroundImage = String(style.backgroundImage ?? '');
    if (!backgroundImage || backgroundImage === 'none') continue;
    if (normalizeText(el.textContent).length > 24) continue;
    const rect = rectOf(el);
    if (rect.width < 120 || rect.height < 80) continue;
    push(el, 'region');
  }
  return out;
}

/**
 * refs → 视口几何（visual-refs 投影）。
 *
 * 只保留有 ref、可见、几何 > 0 的节点（与 JS visual-refs 同口径）；role/name 取节点事实。
 */
export function visualRefsOfNodes(
  nodes: ReadonlyArray<{ id?: string; ref?: string | null; role?: string | null; name?: string | null; visible?: boolean; rect?: { x?: number; y?: number; w?: number; h?: number } | null }>,
): VomVisualRef[] {
  const out: VomVisualRef[] = [];
  for (const node of nodes) {
    const ref = String(node.ref ?? '');
    if (!ref.startsWith('@e')) continue;
    if (node.visible === false) continue;
    const rect = {
      x: Number(node.rect?.x) || 0,
      y: Number(node.rect?.y) || 0,
      width: Math.abs(Number(node.rect?.w) || 0),
      height: Math.abs(Number(node.rect?.h) || 0),
    };
    if (rect.width < 1 || rect.height < 1) continue;
    out.push({
      ref,
      role: node.role ? String(node.role) : null,
      name: node.name ? String(node.name) : null,
      rect,
    });
  }
  return out;
}

/** 区域 + refs → visualObjects 清单（顺序：先区域后 ref；与 JS buildVisualObjects 一致）。 */
export function buildVisualObjects(
  regions: readonly VomVisualRegion[] | null | undefined,
  refs: readonly VomVisualRef[] | null | undefined,
): VomVisualObject[] {
  const out: VomVisualObject[] = [];
  for (const region of Array.isArray(regions) ? regions : []) {
    out.push({
      kind: 'region',
      index: region.index,
      tag: region.tag,
      id: region.id || null,
      rect: { ...region.rect },
    });
  }
  for (const ref of Array.isArray(refs) ? refs : []) {
    out.push({
      kind: 'ref',
      ref: ref.ref,
      role: ref.role || null,
      name: ref.name || null,
      rect: { ...ref.rect },
    });
  }
  return out;
}

/**
 * 计算每个 ref 的 stableRef（与 background 的 buildObservationRefDetails 同一算法）。
 *
 * @param nodes 与 observe 回包同序的节点（只统计带 @eN ref 的）
 * @param context documentId/frameId/cdpSessionId（缺省 frameId=0 / cdpSessionId=null）
 */
export function visualStableRefsOf(
  nodes: ReadonlyArray<{ id?: string; ref?: string | null; role?: string | null; name?: string | null; tag?: string | null }>,
  context: VisualStableRefContext,
): Map<string, string> {
  const documentId = String(context.documentId ?? '');
  const frameId = Number.isInteger(context.frameId) ? Number(context.frameId) : 0;
  const cdpSessionId = context.cdpSessionId ? String(context.cdpSessionId) : '';
  const used = new Map<string, number>();
  const out = new Map<string, string>();
  for (const node of nodes) {
    const ref = String(node.ref ?? '');
    if (!ref.startsWith('@e')) continue;
    const tag = String(node.tag ?? '');
    const id = node.id ? String(node.id) : '';
    const role = node.role ? String(node.role) : '';
    const name = node.name ? String(node.name).slice(0, 120) : '';
    const identity = [cdpSessionId, documentId, frameId, tag, id, role, name].join('|');
    const identityKey = 'i-' + signatureHash(identity);
    const count = (used.get(identityKey) ?? 0) + 1;
    used.set(identityKey, count);
    out.set(ref, 's-' + signatureHash(identity + '#' + count));
  }
  return out;
}

/** 给 visualObjects 的 ref 项回填 stableRef（与 ref 注册表对齐的身份）。 */
export function attachVisualStableRefs(
  objects: VomVisualObject[],
  stableRefs: ReadonlyMap<string, string>,
): VomVisualObject[] {
  for (const object of objects) {
    if (object.kind !== 'ref') continue;
    const stableRef = stableRefs.get(object.ref);
    if (stableRef) object.stableRef = stableRef;
  }
  return objects;
}

/** 便捷入口：扫描 + refs + visualObjects + stableRef 一次算完（rich.ts 只调这一个）。 */
export function collectVisualObjects(input: {
  env: DomEnvironment;
  collected: ReadonlyArray<{ el: ElementLike }>;
  nodes: ReadonlyArray<{ id?: string; ref?: string | null; role?: string | null; name?: string | null; visible?: boolean; tag?: string | null; rect?: { x?: number; y?: number; w?: number; h?: number } | null }>;
  context: VisualStableRefContext;
}): { objects: VomVisualObject[]; regions: VomVisualRegion[]; refs: VomVisualRef[]; stableRefs: Map<string, string> } {
  const regions = scanVisualRegions(input.env, input.collected);
  const refs = visualRefsOfNodes(input.nodes);
  const stableRefs = visualStableRefsOf(input.nodes, input.context);
  const objects = attachVisualStableRefs(buildVisualObjects(regions, refs), stableRefs);
  return { objects, regions, refs, stableRefs };
}
