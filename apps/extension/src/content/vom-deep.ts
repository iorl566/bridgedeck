// src/content/vom-deep.ts —— VOM 深水区页面事实：命中测试 / 屏外 / 文字对比度 / 采集问题。
//
// 源语义（只读参考，不在本文件重造 VOM 判定）：
// - extension/injected/parts/26-action-graph.part 的 hitTestNode（self/descendant/ancestor/
//   blocked/pointer-events-none/offscreen/empty/none/unknown）；
// - extension/injected/parts/31-graph-format.part 的节点字段（hitTest/occludedBy/inViewport/
//   contrast/lowContrast/pointerEvents）与 contrast 阈值（< 4.5 视为低对比度）；
// - extension/injected/parts/30-resolve.part 的取色与 WCAG 计算 → 已移植到
//   packages/vom/src/color.ts（单一实现，本文件只负责“从 DOM 取事实”）。
//
// 边界：没有 CDP，因此没有真实渲染树；命中测试用 document.elementFromPoint（与 JS 页面库
// 同一条 API），颜色来自 computed style；这些事实进入 observe 的节点字段与 vom.graph，
// 不改变任何动作策略（动作层的遮挡判定另有实现）。

import { parseCssColor, compositeColor, contrastRatio, roundContrast } from '../../../../packages/vom/src/color.ts';
import type { CssColorParser, RgbaColor } from '../../../../packages/vom/src/color.ts';
import { normalizeText, roleOfElement, styleOf, tagOf, type DomEnvironment, type ElementLike } from './dom.ts';

/** 低对比度阈值（WCAG AA 正文；与 JS 页面库一致）。 */
export const VOM_LOW_CONTRAST_THRESHOLD = 4.5;

/** 命中测试状态（与 JS 页面的 hitTest 值域一致）。 */
export type VomHitTestState =
  | 'self'
  | 'descendant'
  | 'ancestor'
  | 'blocked'
  | 'pointer-events-none'
  | 'offscreen'
  | 'empty'
  | 'none'
  | 'unknown';

/** 命中/遮挡对象的最小描述（occludedBy）。 */
export interface VomNodeBrief {
  tag: string;
  role: string | null;
  id: string | null;
  name: string | null;
}

/** 深水区节点事实（回填到 rich 节点；observe 直接上抛）。 */
export interface VomDeepNodeFacts {
  /** 命中测试结论；没有元素的节点为 null。 */
  hitTest: VomHitTestState | null;
  /** 被谁挡住（hitTest=blocked 时）；其余为 null。 */
  occludedBy: VomNodeBrief | null;
  /** 是否与视口相交。 */
  inViewport: boolean;
  /** 文字对有效背景的 WCAG 对比度（解析失败为 null）。 */
  contrast: number | null;
  /** contrast 有效且低于阈值时为 true（非文字节点为 false）。 */
  lowContrast: boolean;
  /** 重算后的可点击性：可点击基础 + 命中未被遮挡/未被 pointer-events:none 禁掉。 */
  clickable: boolean;
  /** computed pointer-events 事实。 */
  pointerEvents: string;
}

/** 可被回填的节点形状（rich.ts 的 RichNode 结构兼容）。 */
export interface VomDeepNodeLike {
  id?: string;
  role?: string | null;
  name?: string | null;
  visible?: boolean;
  clickable?: boolean;
  pointerEvents?: string;
  rect?: { x?: number; y?: number; w?: number; h?: number } | null;
  bounds?: { x?: number; y?: number; width?: number; height?: number } | null;
  hitTest?: string | null;
  occludedBy?: VomNodeBrief | null;
  inViewport?: boolean;
  contrast?: number | null;
  lowContrast?: boolean;
}

/** 带文字/可读语义的角色（低对比度只对“能看见文字”的节点下结论）。 */
const TEXT_BEARING_ROLES: ReadonlySet<string> = new Set([
  'paragraph', 'heading', 'listitem', 'cell', 'link', 'button', 'textbox', 'searchbox', 'label', 'note', 'alert',
]);

/** 视口尺寸（缺省 0 → 命中测试给 unknown，不臆测）。 */
export function viewportOf(env: DomEnvironment): { width: number; height: number } {
  return {
    width: Number(env.window.innerWidth) || 0,
    height: Number(env.window.innerHeight) || 0,
  };
}

function rectBoxOf(el: ElementLike): { left: number; top: number; width: number; height: number } {
  try {
    const rect = el.getBoundingClientRect();
    return {
      left: Number(rect?.left) || 0,
      top: Number(rect?.top) || 0,
      width: Math.abs(Number(rect?.width) || 0),
      height: Math.abs(Number(rect?.height) || 0),
    };
  } catch {
    return { left: 0, top: 0, width: 0, height: 0 };
  }
}

/** 元素命中/遮挡最小描述（occludedBy 用；与 JS nodeBrief 同形）。 */
export function nodeBriefOf(el: ElementLike | null | undefined): VomNodeBrief | null {
  if (!el) return null;
  const role = roleOfElement(el);
  return {
    tag: String(tagOf(el)).toLowerCase(),
    role: role || null,
    id: el.id ? String(el.id) : null,
    name: normalizeText(el.getAttribute('aria-label') ?? el.textContent) .slice(0, 60) || null,
  };
}

/** 取文档级命中点元素（shadow/iframe 边界异常时退回文档）。 */
function elementFromPoint(env: DomEnvironment, el: ElementLike, x: number, y: number): ElementLike | null {
  const fallback = env.document as unknown as { elementFromPoint?(px: number, py: number): ElementLike | null };
  let root: { elementFromPoint?(px: number, py: number): ElementLike | null } | null = fallback;
  try {
    const candidate = typeof el.getRootNode === 'function' ? el.getRootNode() : null;
    if (candidate && typeof (candidate as { elementFromPoint?: unknown }).elementFromPoint === 'function') {
      root = candidate as { elementFromPoint(px: number, py: number): ElementLike | null };
    }
  } catch {
    root = fallback;
  }
  try {
    return root && typeof root.elementFromPoint === 'function' ? root.elementFromPoint(x, y) : null;
  } catch {
    return null;
  }
}

/**
 * VOM 命中测试：取元素可见区域中心点做 elementFromPoint。
 *
 * 返回 self/descendant/ancestor 表示可命中；blocked 表示被其他元素挡住；
 * pointer-events-none/offscreen/empty/none/unknown 表示不可命中原因。
 */
export function hitTestNode(env: DomEnvironment, el: ElementLike, style?: { pointerEvents?: string } | null): {
  state: VomHitTestState;
  by: VomNodeBrief | null;
} {
  const computed = style ?? (styleOf(env, el) as { pointerEvents?: string });
  if (String(computed.pointerEvents ?? '') === 'none') return { state: 'pointer-events-none', by: null };
  const viewport = viewportOf(env);
  if (!viewport.width || !viewport.height) return { state: 'unknown', by: null };
  const rect = rectBoxOf(el);
  if (!(rect.width > 0 && rect.height > 0)) return { state: 'empty', by: null };
  const right = rect.left + rect.width;
  const bottom = rect.top + rect.height;
  if (right <= 0 || bottom <= 0 || rect.left >= viewport.width || rect.top >= viewport.height) {
    return { state: 'offscreen', by: null };
  }
  const left = Math.max(rect.left, 0);
  const clampedRight = Math.min(right, viewport.width);
  const top = Math.max(rect.top, 0);
  const clampedBottom = Math.min(bottom, viewport.height);
  if (clampedRight <= left || clampedBottom <= top) return { state: 'offscreen', by: null };
  const x = (left + clampedRight) / 2;
  const y = (top + clampedBottom) / 2;
  const hit = elementFromPoint(env, el, x, y);
  if (!hit) return { state: 'none', by: null };
  if (hit === el) return { state: 'self', by: null };
  try {
    if (typeof el.contains === 'function' && el.contains(hit)) return { state: 'descendant', by: null };
    if (typeof hit.contains === 'function' && hit.contains(el)) return { state: 'ancestor', by: null };
  } catch {
    // contains 不可用时按遮挡处理
  }
  const shadow = (hit as { shadowRoot?: { contains?(other: ElementLike): boolean } | null }).shadowRoot;
  if (shadow && typeof shadow.contains === 'function' && shadow.contains(el)) return { state: 'ancestor', by: null };
  return { state: 'blocked', by: nodeBriefOf(hit) };
}

/** 是否与视口相交（与 JS inViewport 字段同口径）。 */
export function inViewportOf(env: DomEnvironment, el: ElementLike): boolean {
  const viewport = viewportOf(env);
  const rect = rectBoxOf(el);
  return rect.left + rect.width > 0 && rect.top + rect.height > 0
    && rect.left < viewport.width && rect.top < viewport.height;
}

/**
 * 浏览器 canvas 颜色归一钩子（oklch/color-mix 等新语法由浏览器解析）。
 * Node 单测没有 canvas：返回 undefined，纯 TS 解析兜底。
 */
export function createCanvasColorParser(env: DomEnvironment): CssColorParser | undefined {
  try {
    const canvas = env.document.createElement?.('canvas') as unknown as {
      getContext?(type: string): {
        clearRect?(x: number, y: number, w: number, h: number): void;
        fillRect?(x: number, y: number, w: number, h: number): void;
        getImageData?(x: number, y: number, w: number, h: number): { data: ArrayLike<number> };
        fillStyle?: string;
      } | null;
    } | null;
    const context = canvas && canvas.getContext ? canvas.getContext('2d') : null;
    if (!context) return undefined;
    const fillRect = context.fillRect;
    const getImageData = context.getImageData;
    if (typeof getImageData !== 'function' || typeof fillRect !== 'function') return undefined;
    const ctx = context;
    return (text: string): RgbaColor | null => {
      try {
        ctx.clearRect?.(0, 0, 1, 1);
        ctx.fillStyle = '#000';
        ctx.fillStyle = text;
        fillRect.call(ctx, 0, 0, 1, 1);
        const data = getImageData.call(ctx, 0, 0, 1, 1);
        if (!data || data.data.length < 3) return null;
        return {
          r: Number(data.data[0] ?? 0),
          g: Number(data.data[1] ?? 0),
          b: Number(data.data[2] ?? 0),
          a: Number(data.data[3] ?? 255) / 255,
        };
      } catch {
        return null;
      }
    };
  } catch {
    return undefined;
  }
}

/** 有效背景色：从元素向上叠加非透明 backgroundColor，直到不透明层（或白底）。 */
export function effectiveBackgroundColor(env: DomEnvironment, el: ElementLike | null | undefined, hook?: CssColorParser): RgbaColor {
  const layers: RgbaColor[] = [];
  let node: ElementLike | null | undefined = el;
  let guard = 0;
  while (node && guard < 64) {
    let color: RgbaColor | null = null;
    try {
      const style = styleOf(env, node) as { backgroundColor?: string };
      color = parseCssColor(style.backgroundColor, hook);
    } catch {
      color = null;
    }
    if (color && color.a > 0) layers.push(color);
    if (color && color.a >= 1) break;
    node = node.parentElement ?? null;
    guard += 1;
  }
  let base: RgbaColor = { r: 255, g: 255, b: 255, a: 1 };
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const layer = layers[index];
    if (layer) base = compositeColor(layer, base);
  }
  return base;
}

/** 元素文字对有效背景的 WCAG 对比度（解析失败 null；两位小数）。 */
export function nodeContrast(env: DomEnvironment, el: ElementLike | null | undefined, hook?: CssColorParser): number | null {
  if (!el) return null;
  try {
    const style = styleOf(env, el) as { color?: string };
    const foreground = parseCssColor(style.color, hook);
    if (!foreground) return null;
    const background = effectiveBackgroundColor(env, el, hook);
    const text = foreground.a < 1 ? compositeColor(foreground, background) : foreground;
    const ratio = contrastRatio(text, background);
    return Number.isFinite(ratio) ? roundContrast(ratio) : null;
  } catch {
    return null;
  }
}

/** 单节点深水区事实（纯读取；不改变 DOM）。 */
export function deepFactsOfNode(
  env: DomEnvironment,
  el: ElementLike | null | undefined,
  node: VomDeepNodeLike,
  hook?: CssColorParser,
): VomDeepNodeFacts {
  if (!el) {
    const bounds = (node.bounds ?? node.rect ?? {}) as { x?: number; y?: number; width?: number; height?: number; w?: number; h?: number };
    const viewport = viewportOf(env);
    const x = Number(bounds.x) || 0;
    const y = Number(bounds.y) || 0;
    const width = Number(bounds.width ?? bounds.w) || 0;
    const height = Number(bounds.height ?? bounds.h) || 0;
    return {
      hitTest: null,
      occludedBy: null,
      inViewport: x + width > 0 && y + height > 0 && x < viewport.width && y < viewport.height,
      contrast: null,
      lowContrast: false,
      clickable: node.clickable === true,
      pointerEvents: String(node.pointerEvents ?? 'auto'),
    };
  }
  const style = styleOf(env, el) as { pointerEvents?: string; cursor?: string };
  const hit = hitTestNode(env, el, style);
  const clickableBase = node.clickable === true || String(style.cursor ?? '') === 'pointer'
    || el.getAttribute('onclick') !== null;
  const clickable = clickableBase && hit.state !== 'blocked' && hit.state !== 'pointer-events-none';
  const role = String(node.role ?? '').toLowerCase();
  const name = String(node.name ?? '');
  const textBearing = name.length > 0 || TEXT_BEARING_ROLES.has(role);
  const contrast = nodeContrast(env, el, hook);
  return {
    hitTest: hit.state,
    occludedBy: hit.state === 'blocked' ? hit.by : null,
    inViewport: inViewportOf(env, el),
    contrast,
    lowContrast: contrast != null && textBearing && contrast < VOM_LOW_CONTRAST_THRESHOLD,
    clickable,
    pointerEvents: String(style.pointerEvents ?? 'auto'),
  };
}

/** 回填入口：nodes 与 element 一一对应；返回回填后的节点（同一批对象，原地写）。 */
export function applyDeepNodeFacts(
  env: DomEnvironment,
  entries: ReadonlyArray<{ node: VomDeepNodeLike; element: ElementLike | null | undefined }>,
  options: { hook?: CssColorParser } = {},
): VomDeepNodeFacts[] {
  const hook = options.hook ?? createCanvasColorParser(env);
  const out: VomDeepNodeFacts[] = [];
  for (const entry of entries) {
    const facts = deepFactsOfNode(env, entry.element ?? null, entry.node, hook);
    const node = entry.node;
    node.hitTest = facts.hitTest;
    node.occludedBy = facts.occludedBy;
    node.inViewport = facts.inViewport;
    node.contrast = facts.contrast;
    node.lowContrast = facts.lowContrast;
    node.clickable = facts.clickable;
    node.pointerEvents = facts.pointerEvents;
    out.push(facts);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 采集问题（observe 的 issues / vom.issues；正常页面为空数组，不伪造 issue）
// ---------------------------------------------------------------------------

/** 单条采集问题。 */
export interface VomCaptureIssue {
  stage: string;
  reason: string;
}

/** 问题收集器：只记录真实失败，不做推测。 */
export interface VomCaptureIssueSink {
  readonly issues: VomCaptureIssue[];
  note(stage: string, error: unknown): void;
}

/** 建一个采集问题收集器（rich.ts 在阶段失败时调用 note）。 */
export function createVomCaptureIssues(): VomCaptureIssueSink {
  const issues: VomCaptureIssue[] = [];
  return {
    issues,
    note(stage: string, error: unknown): void {
      if (issues.length >= 24) return;
      const message = typeof error === 'string'
        ? error
        : (error instanceof Error ? error.message : String(error ?? 'unknown'));
      issues.push({ stage: String(stage || 'unknown'), reason: message.slice(0, 240) });
    },
  };
}

/** 深水区固定限制说明（随 observe 一起上抛，如实标注能力边界）。 */
export const VOM_DEEP_LIMITATIONS: readonly string[] = Object.freeze([
  '命中测试用 document.elementFromPoint（页面库同一条 API）；没有 CDP 渲染树，不是 compositor hit-test',
  '对比度来自 computed style + 向上叠加背景色；颜色解析用 packages/vom/color（浏览器 canvas 兜底）',
  '遮挡只报告“中心点最上层不是目标/其祖先/其后代”的元素；不判断可穿透的透明遮罩',
]);
