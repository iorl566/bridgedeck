// src/content/advanced.ts —— 第三批页面侧能力：只读事实、薄动作、结构化提取、资源计时。
//
// 为什么单独一层而不是继续堆进 dom.ts：
// - dom.ts 是 M-C 第二批的“四个核心动作 + 三个薄动作”，已经有稳定单测；
// - 第三批的面是**只读事实**（metrics/element-state/visual-refs/network-entries）、
//   通用薄动作（scroll/hover/focus/press/wheel/blur/drag/click-point）与提取
//   （extract/discover），它们共享“目标解析 + 几何 + 可见性”的底座，但产物形状不同；
// - 全部函数保持**纯逻辑 + 注入 DomEnvironment**，可以在 Node 里用 fake DOM 单测。
//
// 硬约束沿用第二批：不使用 chrome.debugger；输入是合成事件，证据里 trusted:false、
// synthetic:true、via:'content-script' 如实标注；网络只读面用 PerformanceResourceTiming
// （没有请求头/响应体/HTTP 方法，字段缺省就是 null，不编造）。

import {
  accessibleNameOf,
  classifyHit,
  isVisible,
  normalizeText,
  PageError,
  rectOf,
  resolveTarget,
  roleOfElement,
  tagOf,
  type DomEnvironment,
  type ElementLike,
  type ResolvedTarget,
} from './dom.ts';
import type {
  ContentElementState,
  ContentExtractColumn,
  ContentExtractPayload,
  ContentExtractTarget,
  ContentMetricsResult,
  ContentNetworkEntriesResult,
  ContentNetworkEntry,
  ContentRect,
  ContentScrollResult,
  ContentThinActionResult,
  ContentVisualRef,
  ContentVisualRefsResult,
} from './protocol.ts';

// ---------------------------------------------------------------------------
// 基础事实
// ---------------------------------------------------------------------------

function scrollXOf(env: DomEnvironment): number {
  const value = Number(env.window.scrollX);
  return Number.isFinite(value) ? value : 0;
}

function scrollYOf(env: DomEnvironment): number {
  const value = Number(env.window.scrollY);
  return Number.isFinite(value) ? value : 0;
}

function viewportOf(env: DomEnvironment): { width: number; height: number } {
  return {
    width: Math.max(0, Number(env.window.innerWidth) || 0),
    height: Math.max(0, Number(env.window.innerHeight) || 0),
  };
}

function dprOf(env: DomEnvironment): number {
  const value = Number(env.window.devicePixelRatio);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function viewportRectOf(el: ElementLike): ContentRect {
  const rect = rectOf(el);
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

/** 固定带扫描上限：只扫一层常见固定元素，不做完整层树（长截图重绘用）。 */
const FIXED_BAND_SCAN_LIMIT = 3000;

/**
 * 固定顶/底带识别：扫 `body *` 里 position 为 fixed/sticky 的元素，
 * 取贴视口顶部（top≈0 且没占满半屏）的最高下沿为顶栏，贴视口底部（bottom≈视口底且顶部过半屏）
 * 的最高顶部为页脚。与 0.3.0 的 page-metrics 口径一致。
 *
 * 结果用于长截图**重绘**：滚动采集时固定元素每帧都贴在视口里，拼接后必须在首/末段重画，
 * 否则整页会出现重复横条。识别失败一律返回 0（不阻断截图）。
 */
export function fixedBandsOf(env: DomEnvironment): {
  fixedTopHeight: number;
  fixedBottomHeight: number;
  fixedBands: Array<{ edge: 'top' | 'bottom'; height: number; top: number; bottom: number }>;
} {
  const fixedBands: Array<{ edge: 'top' | 'bottom'; height: number; top: number; bottom: number }> = [];
  const viewportHeight = viewportOf(env).height;
  let fixedTopHeight = 0;
  let fixedBottomHeight = 0;
  if (!(viewportHeight > 0)) return { fixedTopHeight, fixedBottomHeight, fixedBands };
  const getStyle = env.window.getComputedStyle;
  if (typeof getStyle !== 'function') return { fixedTopHeight, fixedBottomHeight, fixedBands };
  let elements: ArrayLike<ElementLike>;
  try {
    const all = env.document.querySelectorAll?.('body *');
    if (!all) return { fixedTopHeight, fixedBottomHeight, fixedBands };
    elements = all;
  } catch {
    return { fixedTopHeight, fixedBottomHeight, fixedBands };
  }
  const count = Math.min(Number(elements.length) || 0, FIXED_BAND_SCAN_LIMIT);
  for (let index = 0; index < count; index += 1) {
    const element = elements[index];
    if (!element) continue;
    let style: { position?: string } | null = null;
    try {
      style = getStyle.call(env.window, element) as { position?: string } | null;
    } catch {
      continue;
    }
    if (!style || (style.position !== 'fixed' && style.position !== 'sticky')) continue;
    let rect: { top: number; bottom: number; width: number; height: number };
    try {
      const box = element.getBoundingClientRect();
      const top = Number(box.top) || 0;
      const height = Number(box.height) || 0;
      rect = {
        top,
        bottom: Number.isFinite(Number(box.bottom)) ? Number(box.bottom) : top + height,
        width: Number(box.width) || 0,
        height,
      };
    } catch {
      continue;
    }
    if (rect.width <= 0 || rect.height <= 0 || rect.height > viewportHeight * 0.6) continue;
    if (rect.bottom >= viewportHeight - 2 && rect.top > viewportHeight * 0.5) {
      fixedBottomHeight = Math.max(fixedBottomHeight, Math.round(viewportHeight - rect.top));
      if (fixedBands.length < 8) {
        fixedBands.push({ edge: 'bottom', height: Math.round(rect.height), top: Math.round(rect.top), bottom: Math.round(rect.bottom) });
      }
    }
    if (rect.top <= 2 && rect.bottom < viewportHeight * 0.5) {
      fixedTopHeight = Math.max(fixedTopHeight, Math.round(rect.bottom));
      if (fixedBands.length < 8) {
        fixedBands.push({ edge: 'top', height: Math.round(rect.height), top: Math.round(rect.top), bottom: Math.round(rect.bottom) });
      }
    }
  }
  return { fixedTopHeight, fixedBottomHeight, fixedBands };
}

/** 页面度量：full-page 截图、scroll 边界与性能证据共用。 */
export function pageMetrics(env: DomEnvironment, documentId: string): ContentMetricsResult {
  const doc = env.document;
  const root = doc.documentElement ?? doc.body ?? null;
  const scrollWidth = Math.max(Number(root?.scrollWidth) || 0, viewportOf(env).width);
  const scrollHeight = Math.max(Number(root?.scrollHeight) || 0, viewportOf(env).height);
  const bands = fixedBandsOf(env);
  return {
    url: String(doc.URL ?? ''),
    title: String(doc.title ?? ''),
    scrollX: scrollXOf(env),
    scrollY: scrollYOf(env),
    innerWidth: viewportOf(env).width,
    innerHeight: viewportOf(env).height,
    scrollWidth,
    scrollHeight,
    devicePixelRatio: dprOf(env),
    documentId,
    fixedTopHeight: bands.fixedTopHeight,
    fixedBottomHeight: bands.fixedBottomHeight,
    fixedBands: bands.fixedBands,
  };
}

/** 元素当前状态（是否存在/可见/几何/是否在视口内）。 */
export function elementStateOf(env: DomEnvironment, resolved: ResolvedTarget | null): ContentElementState {
  if (!resolved) {
    return {
      attached: false,
      visible: false,
      rect: { x: 0, y: 0, width: 0, height: 0 },
      tag: '',
      id: null,
      role: null,
      name: null,
      value: null,
      disabled: false,
      inViewport: false,
      ref: null,
      selector: null,
      href: null,
    };
  }
  const el = resolved.element;
  const rect = viewportRectOf(el);
  const viewport = viewportOf(env);
  const href = tagOf(el) === 'A' ? String((el as unknown as { href?: string }).href ?? '') || null : null;
  return {
    attached: el.isConnected !== false,
    visible: isVisible(env, el),
    rect,
    tag: tagOf(el).toLowerCase(),
    id: el.id ? String(el.id) : null,
    role: roleOfElement(el),
    name: accessibleNameOf(el) || null,
    value: typeof (el as { value?: string }).value === 'string' ? String((el as { value?: string }).value) : null,
    disabled: (el as { disabled?: boolean }).disabled === true,
    inViewport: rect.x < viewport.width && rect.y < viewport.height && rect.x + rect.width > 0 && rect.y + rect.height > 0,
    ref: resolved.ref,
    selector: resolved.selector,
    href,
  };
}

/** 当前 ref 表的视口几何（annotate / 按图点击的坐标来源）。 */
export function visualRefsOf(
  env: DomEnvironment,
  entries: ReadonlyArray<{ ref: string; element: ElementLike }>,
  url: string,
): ContentVisualRefsResult {
  const refs: ContentVisualRef[] = [];
  for (const entry of entries) {
    if (!entry || !entry.ref || !entry.element) continue;
    if (entry.element.isConnected === false) continue;
    if (!isVisible(env, entry.element)) continue;
    const rect = viewportRectOf(entry.element);
    if (rect.width < 1 || rect.height < 1) continue;
    refs.push({
      ref: entry.ref,
      role: roleOfElement(entry.element),
      name: accessibleNameOf(entry.element) || null,
      rect,
      pageX: scrollXOf(env) + rect.x,
      pageY: scrollYOf(env) + rect.y,
    });
  }
  return {
    refs,
    scrollX: scrollXOf(env),
    scrollY: scrollYOf(env),
    innerWidth: viewportOf(env).width,
    innerHeight: viewportOf(env).height,
    devicePixelRatio: dprOf(env),
    url,
  };
}

// ---------------------------------------------------------------------------
// scroll
// ---------------------------------------------------------------------------

export interface ScrollOptions {
  /** 给 y 时滚到绝对位置（CSS px）；给 x 同理。 */
  x?: number | null;
  y?: number | null;
  /** element 模式：滚到目标元素（scrollIntoView）；缺省时按 x/y 滚窗口。 */
  resolved?: ResolvedTarget | null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function readWindowScroll(env: DomEnvironment): { x: number; y: number } {
  const windowBag = env.window as { scrollX?: number; scrollY?: number; pageXOffset?: number; pageYOffset?: number };
  const x = Number.isFinite(Number(windowBag.scrollX)) ? Number(windowBag.scrollX) : Number(windowBag.pageXOffset) || 0;
  const y = Number.isFinite(Number(windowBag.scrollY)) ? Number(windowBag.scrollY) : Number(windowBag.pageYOffset) || 0;
  return { x, y };
}

/** 滚动窗口/元素：返回滚动后的位置、目标边界与视口；越界时如实给 clamped 值。 */
export function scrollPage(env: DomEnvironment, options: ScrollOptions = {}): ContentScrollResult {
  const root = env.document.documentElement ?? env.document.body ?? null;
  const viewport = viewportOf(env);
  const maxScrollX = Math.max(0, (Number(root?.scrollWidth) || viewport.width) - viewport.width);
  const maxScrollY = Math.max(0, (Number(root?.scrollHeight) || viewport.height) - viewport.height);
  const before = readWindowScroll(env);
  let targetX = before.x;
  let targetY = before.y;
  let bounds: ContentRect | null = null;
  if (options.resolved) {
    const el = options.resolved.element;
    try {
      el.scrollIntoView?.({ block: 'center', inline: 'center' });
    } catch {
      // scrollIntoView 不可用（fake DOM）时退化为什么都不做
    }
    const rect = rectOf(el);
    const pageY = scrollYOf(env) + rect.top;
    targetY = pageY - Math.max(0, (viewport.height - rect.height) / 2);
    bounds = { x: rect.left + scrollXOf(env), y: pageY, width: rect.width, height: rect.height };
  } else {
    if (Number.isFinite(Number(options.x))) targetX = Number(options.x);
    if (Number.isFinite(Number(options.y))) targetY = Number(options.y);
  }
  const clampedX = clamp(Math.round(targetX), 0, Math.round(maxScrollX));
  const clampedY = clamp(Math.round(targetY), 0, Math.round(maxScrollY));
  try {
    if (typeof env.window.scrollTo === 'function') env.window.scrollTo(clampedX, clampedY);
    else {
      // fake DOM：直接写 scroll 值
      const writable = env.window as { scrollX?: number; scrollY?: number };
      writable.scrollX = clampedX;
      writable.scrollY = clampedY;
    }
  } catch (error) {
    throw new PageError('E_SCROLL_FAILED', '滚动失败：' + (error instanceof Error ? error.message : String(error)));
  }
  const after = readWindowScroll(env);
  return {
    ok: true,
    scrollX: after.x,
    scrollY: after.y,
    clampedX,
    clampedY,
    bounds,
    viewport,
    ref: options.resolved?.ref ?? null,
    selector: options.resolved?.selector ?? null,
    via: 'content-script',
  };
}

// ---------------------------------------------------------------------------
// 合成事件动作
// ---------------------------------------------------------------------------

interface DispatchInit {
  [key: string]: unknown;
}

function synthEvent(env: DomEnvironment, type: string, init: DispatchInit): unknown {
  try {
    return env.createEvent?.(type, { bubbles: true, cancelable: true, composed: true, ...init }) ?? null;
  } catch {
    return null;
  }
}

function fire(env: DomEnvironment, el: ElementLike, type: string, init: DispatchInit = {}): boolean {
  const event = synthEvent(env, type, init);
  if (!event || typeof el.dispatchEvent !== 'function') return false;
  try {
    return el.dispatchEvent(event) !== false;
  } catch {
    return false;
  }
}

function centerOfTarget(env: DomEnvironment, el: ElementLike): { x: number; y: number } | null {
  const rect = rectOf(el);
  if (rect.width <= 0 || rect.height <= 0) return null;
  return { x: scrollXOf(env) + rect.left + rect.width / 2, y: scrollYOf(env) + rect.top + rect.height / 2 };
}

function mouseInit(point: { x: number; y: number } | null, extra: DispatchInit = {}): DispatchInit {
  const x = point ? point.x : 0;
  const y = point ? point.y : 0;
  return {
    clientX: x - 0,
    clientY: y - 0,
    screenX: x,
    screenY: y,
    button: 0,
    buttons: 0,
    view: null,
    ...extra,
  };
}

/** hover：把鼠标移入目标（mouseover/mouseenter/mousemove）。 */
export function hoverElement(env: DomEnvironment, resolved: ResolvedTarget): ContentThinActionResult {
  const el = resolved.element;
  const point = centerOfTarget(env, el);
  try {
    el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  } catch {
    // 忽略
  }
  fire(env, el, 'mouseover', mouseInit(point));
  fire(env, el, 'mouseenter', mouseInit(point, { bubbles: false }));
  fire(env, el, 'mousemove', mouseInit(point));
  return {
    ok: true,
    via: 'content-script',
    trusted: false,
    synthetic: true,
    tag: tagOf(el).toLowerCase(),
    ref: resolved.ref,
    selector: resolved.selector,
    x: point ? point.x : null,
    y: point ? point.y : null,
    targetTag: tagOf(el).toLowerCase(),
    generated: 3,
  };
}

/** focus：聚焦目标（可选 target；缺省聚焦 body）。 */
export function focusElement(env: DomEnvironment, resolved: ResolvedTarget | null): ContentThinActionResult {
  const el = resolved?.element ?? env.document.body ?? env.document.documentElement ?? null;
  if (!el) throw new PageError('E_NOT_FOUND', '页面没有可聚焦的元素');
  try {
    el.focus?.();
  } catch (error) {
    throw new PageError('E_NOT_ACTIONABLE', '聚焦失败：' + (error instanceof Error ? error.message : String(error)));
  }
  const active = env.document.activeElement;
  return {
    ok: true,
    via: 'content-script',
    trusted: false,
    synthetic: true,
    tag: tagOf(el).toLowerCase(),
    ref: resolved?.ref ?? null,
    selector: resolved?.selector ?? null,
    x: null,
    y: null,
    activeTag: active ? tagOf(active).toLowerCase() : null,
  };
}

/** blur：取消焦点（失焦后触发 blur/focusout 的页面逻辑才可被验证）。 */
export function blurElement(env: DomEnvironment, resolved: ResolvedTarget | null): ContentThinActionResult {
  const active = resolved?.element ?? env.document.activeElement ?? null;
  if (!active) {
    return {
      ok: true,
      via: 'content-script',
      trusted: false,
      synthetic: true,
      tag: null,
      ref: null,
      selector: null,
      x: null,
      y: null,
      activeTag: null,
    };
  }
  try {
    active.blur?.();
    fire(env, active, 'blur', { bubbles: false });
    fire(env, active, 'focusout', { bubbles: true });
  } catch (error) {
    throw new PageError('E_NOT_ACTIONABLE', '失焦失败：' + (error instanceof Error ? error.message : String(error)));
  }
  const next = env.document.activeElement;
  return {
    ok: true,
    via: 'content-script',
    trusted: false,
    synthetic: true,
    tag: tagOf(active).toLowerCase(),
    ref: resolved?.ref ?? null,
    selector: resolved?.selector ?? null,
    x: null,
    y: null,
    activeTag: next ? tagOf(next).toLowerCase() : null,
  };
}

/** press：向目标（缺省 activeElement/body）派发 keydown/keypress/keyup。 */
export function pressKey(env: DomEnvironment, resolved: ResolvedTarget | null, key: string): ContentThinActionResult {
  const name = String(key ?? '').trim();
  if (!name) throw new PageError('E_BAD_ARG', 'press 需要非空 key');
  const el = resolved?.element ?? env.document.activeElement ?? env.document.body ?? env.document.documentElement ?? null;
  if (!el) throw new PageError('E_NOT_FOUND', '页面没有可接收按键的元素');
  const init = { key: name, code: name, bubbles: true };
  let generated = 0;
  if (fire(env, el, 'keydown', init)) generated += 1;
  if (fire(env, el, 'keypress', init)) generated += 1;
  if (fire(env, el, 'keyup', init)) generated += 1;
  return {
    ok: true,
    via: 'content-script',
    trusted: false,
    synthetic: true,
    tag: tagOf(el).toLowerCase(),
    ref: resolved?.ref ?? null,
    selector: resolved?.selector ?? null,
    x: null,
    y: null,
    key: name,
    generated,
    targetTag: tagOf(el).toLowerCase(),
  };
}

/** wheel：在目标/窗口上派发 wheel 并滚动滚动容器（或窗口）。 */
export function wheelScroll(env: DomEnvironment, resolved: ResolvedTarget | null, deltaX: number, deltaY: number): ContentThinActionResult {
  const el = resolved?.element ?? env.document.documentElement ?? env.document.body ?? null;
  if (!el) throw new PageError('E_NOT_FOUND', '页面没有可滚动的元素');
  const dx = Number.isFinite(deltaX) ? Math.round(deltaX) : 0;
  const dy = Number.isFinite(deltaY) ? Math.round(deltaY) : 0;
  fire(env, el, 'wheel', { deltaX: dx, deltaY: dy, deltaMode: 0 });
  // 元素自身可滚动时优先滚它，否则滚窗口（与浏览器默认行为一致的最小实现）。
  let scrolled = 0;
  try {
    const scrollable = Number(el.scrollHeight) > Number(env.window.innerHeight) && Number(el.scrollHeight) > 0
      && (el as { scrollTop?: number }).scrollTop !== undefined;
    if (scrollable) {
      const target = el as { scrollTop?: number; scrollLeft?: number };
      target.scrollTop = Math.max(0, (Number(target.scrollTop) || 0) + dy);
      target.scrollLeft = Math.max(0, (Number(target.scrollLeft) || 0) + dx);
      scrolled = 1;
    }
  } catch {
    scrolled = 0;
  }
  if (!scrolled) {
    const nextX = Math.max(0, scrollXOf(env) + dx);
    const nextY = Math.max(0, scrollYOf(env) + dy);
    try {
      if (typeof env.window.scrollTo === 'function') env.window.scrollTo(nextX, nextY);
      else {
        const writable = env.window as { scrollX?: number; scrollY?: number };
        writable.scrollX = nextX;
        writable.scrollY = nextY;
      }
    } catch {
      // 忽略滚动失败（事件仍然派发过）
    }
  }
  const viewport = viewportOf(env);
  const root = env.document.documentElement ?? env.document.body ?? null;
  const maxY = Math.max(0, (Number(root?.scrollHeight) || viewport.height) - viewport.height);
  return {
    ok: true,
    via: 'content-script',
    trusted: false,
    synthetic: true,
    tag: tagOf(el).toLowerCase(),
    ref: resolved?.ref ?? null,
    selector: resolved?.selector ?? null,
    x: null,
    y: null,
    scrollX: scrollXOf(env),
    scrollY: scrollYOf(env),
    atTop: scrollYOf(env) <= 0,
    atBottom: scrollYOf(env) >= maxY - 1,
    generated: 1,
  };
}

export interface DragOptions {
  dx: number;
  dy: number;
  holdMs?: number;
  durationMs?: number;
  steps?: number;
  /** 落点目标（--to）：pointerup/mouseup 派发到该元素（页面 drop 处理器挂在落点容器上）。 */
  toSelector?: string | null;
  /** 修饰键（--modifiers ctrl+shift）：随事件 init 传给页面处理器。 */
  modifiers?: string[];
}

/** drag：从目标中心按 dx/dy 派发 mousedown → mousemove×N → pointerup/mouseup（合成事件）。 */
export function dragElement(env: DomEnvironment, resolved: ResolvedTarget, options: DragOptions): ContentThinActionResult {
  const el = resolved.element;
  try {
    el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  } catch {
    // 忽略
  }
  const from = centerOfTarget(env, el);
  if (!from) throw new PageError('E_NOT_ACTIONABLE', '拖拽目标尺寸为 0', { reason: 'zero-size' });
  const dx = Number.isFinite(options.dx) ? Math.round(options.dx) : 0;
  const dy = Number.isFinite(options.dy) ? Math.round(options.dy) : 0;
  const steps = Math.min(Math.max(1, Math.round(options.steps ?? 6) || 6), 32);
  const modifiers = Array.isArray(options.modifiers) ? options.modifiers.map((item) => String(item).toLowerCase()) : [];
  const modifierInit = {
    ctrlKey: modifiers.includes('ctrl'),
    shiftKey: modifiers.includes('shift'),
    altKey: modifiers.includes('alt') || modifiers.includes('option'),
    metaKey: modifiers.includes('meta') || modifiers.includes('cmd'),
  };
  const to = { x: from.x + dx, y: from.y + dy };
  // 落点元素：优先 --to 选择器（页面 drop 处理器通常挂在落点容器上），
  // 否则用命中测试结果，最后退回起点元素（--dx/--dy 位移拖拽语义）。
  const dropTarget: ElementLike = (() => {
    const selector = typeof options.toSelector === 'string' && options.toSelector.trim() ? options.toSelector.trim() : '';
    if (selector) {
      try {
        const found = env.document.querySelector?.(selector) ?? null;
        if (found) return found;
      } catch {
        // 选择器非法时退回命中测试
      }
    }
    try {
      return env.document.elementFromPoint?.(to.x, to.y) ?? el;
    } catch {
      return el;
    }
  })();
  fire(env, el, 'mousedown', mouseInit(from, { buttons: 1, button: 0, ...modifierInit }));
  fire(env, el, 'pointerdown', mouseInit(from, { buttons: 1, button: 0, pointerType: 'mouse', ...modifierInit }));
  for (let index = 1; index <= steps; index += 1) {
    const point = { x: from.x + (dx * index) / steps, y: from.y + (dy * index) / steps };
    fire(env, el, 'mousemove', mouseInit(point, { buttons: 1 }));
    fire(env, el, 'pointermove', mouseInit(point, { buttons: 1, pointerType: 'mouse' }));
  }
  // 落点事件：dropzone 的 pointerup/drop 处理器要能收到（source 上的 pointerup 不会冒泡到兄弟节点）。
  fire(env, dropTarget, 'pointerover', mouseInit(to, { buttons: 0, pointerType: 'mouse' }));
  fire(env, dropTarget, 'pointerup', mouseInit(to, { button: 0, pointerType: 'mouse', ...modifierInit }));
  fire(env, dropTarget, 'mouseup', mouseInit(to, { button: 0, ...modifierInit }));
  return {
    ok: true,
    via: 'content-script',
    trusted: false,
    synthetic: true,
    tag: tagOf(el).toLowerCase(),
    ref: resolved.ref,
    selector: resolved.selector,
    x: from.x,
    y: from.y,
    from,
    to,
    steps,
    generated: 3 + steps * 2,
    targetTag: tagOf(dropTarget).toLowerCase(),
    modifiers,
  } as ContentThinActionResult & { modifiers: string[] };
}

/** click-point：按页面坐标命中测试后合成点击（视觉坐标动作的最后一步）。 */
export function clickPoint(env: DomEnvironment, pageX: number, pageY: number): ContentThinActionResult {
  const x = Number(pageX);
  const y = Number(pageY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new PageError('E_BAD_ARG', 'click-point 需要有限数值坐标', { x: pageX, y: pageY });
  const clientX = x - scrollXOf(env);
  const clientY = y - scrollYOf(env);
  let hit: ElementLike | null = null;
  try {
    hit = env.document.elementFromPoint?.(clientX, clientY) ?? null;
  } catch {
    hit = null;
  }
  if (!hit) throw new PageError('E_NOT_FOUND', '坐标下没有元素', { x, y, clientX, clientY });
  const init = { clientX, clientY, screenX: x, screenY: y, button: 0, bubbles: true, view: null };
  fire(env, hit, 'mousedown', init);
  fire(env, hit, 'mouseup', init);
  const relation = classifyHit(hit, hit);
  try {
    hit.click?.();
  } catch (error) {
    throw new PageError('E_NOT_ACTIONABLE', '坐标点击失败：' + (error instanceof Error ? error.message : String(error)));
  }
  return {
    ok: true,
    via: 'content-script',
    trusted: false,
    synthetic: true,
    tag: tagOf(hit).toLowerCase(),
    ref: null,
    selector: null,
    x,
    y,
    targetTag: tagOf(hit).toLowerCase(),
    hit: relation,
  } as ContentThinActionResult;
}

// ---------------------------------------------------------------------------
// read --fields-json（字段映射式读取）
// ---------------------------------------------------------------------------

/**
 * 按字段规格读取：返回一组扁平对象（键来自 specs），供 CLI `read --fields-json` 使用。
 * 与 readFields 的默认形状并存：结果里 flatFields 有值时 background 直接采用（不再包成
 * ContentReadField），保证两种读法互不破坏。
 */
export function readFieldSpecs(
  env: DomEnvironment,
  resolved: ResolvedTarget,
  specs: readonly FieldSpec[],
): { fields: never[]; flatFields: Array<Record<string, unknown>>; ref: string | null; selector: string | null; count: number } {
  void env;
  const list = specs.length ? specs : DEFAULT_LIST_FIELDS;
  const flat: Record<string, unknown> = {};
  for (const spec of list) flat[spec.key] = readFieldOf(resolved.element, spec);
  const fields = [flat];
  return {
    fields: [],
    flatFields: fields,
    ref: resolved.ref,
    selector: resolved.selector,
    count: fields.length,
  };
}

// ---------------------------------------------------------------------------
// 结构化提取（table / list / discover）
// ---------------------------------------------------------------------------

const MAX_EXTRACT_ROWS = 2000;
const MAX_EXTRACT_TARGETS = 32;
const PREVIEW_COLUMNS = 8;
const PREVIEW_SAMPLE = 3;
const LIMITS = Object.freeze({ maxFrames: 16, maxTargets: MAX_EXTRACT_TARGETS, previewColumns: PREVIEW_COLUMNS });

/** 轻量 DOM 指纹（FNV-1a over 结构+文本摘要）：分页 cursor 的“页面已变化”证据。 */
export function domFingerprint(env: DomEnvironment): string {
  const root = env.document.documentElement ?? env.document.body ?? null;
  let text = '';
  try {
    const html = String(root?.outerHTML ?? root?.innerHTML ?? '');
    text = html.slice(0, 200_000);
  } catch {
    text = '';
  }
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(36) + '-' + text.length.toString(36);
}

function queryAll(el: ElementLike | null | undefined, selector: string): ElementLike[] {
  if (!el) return [];
  try {
    const list = el.querySelectorAll?.(selector);
    return list ? Array.from(list) : [];
  } catch {
    return [];
  }
}

function directRowsOf(table: ElementLike): ElementLike[] {
  const rows = queryAll(table, 'tr');
  if (rows.length) return rows;
  return queryAll(table, '[role="row"]');
}

function cellsOf(row: ElementLike): ElementLike[] {
  const cells = queryAll(row, 'td,th');
  if (cells.length) return cells;
  return queryAll(row, '[role="gridcell"],[role="columnheader"],[role="rowheader"]');
}

function isHeaderCell(el: ElementLike): boolean {
  const tag = tagOf(el);
  if (tag === 'TH') return true;
  return String(el.getAttribute('role') ?? '').toLowerCase() === 'columnheader';
}

function spanOf(el: ElementLike, key: 'rowspan' | 'colspan'): number {
  const raw = Number(el.getAttribute(key));
  return Number.isInteger(raw) && raw > 0 ? Math.min(raw, 64) : 1;
}

function readCellText(el: ElementLike): string {
  return normalizeText(el.textContent);
}

/**
 * 展开多行表头（rowspan/colspan）→ 每列的组合标签。
 * 例：`等级(rowspan=2) | 金额(colspan=2)` + `小 | 大` → `等级`、`金额 / 小`、`金额 / 大`。
 */
function expandHeaderLabels(headerRows: readonly ElementLike[]): string[] {
  const grid: string[][] = [];
  let maxCol = 0;
  for (let rowIndex = 0; rowIndex < headerRows.length; rowIndex += 1) {
    const row = headerRows[rowIndex];
    if (!row) continue;
    let cursor = 0;
    for (const cell of cellsOf(row)) {
      // 找当前行第一个空位（rowspan 占位可能让 cursor 需要右移）。
      while (grid[rowIndex]?.[cursor] !== undefined) cursor += 1;
      const label = readCellText(cell);
      const rowspan = spanOf(cell, 'rowspan');
      const colspan = spanOf(cell, 'colspan');
      for (let dr = 0; dr < rowspan; dr += 1) {
        const targetRow = rowIndex + dr;
        grid[targetRow] = grid[targetRow] ?? [];
        for (let dc = 0; dc < colspan; dc += 1) {
          grid[targetRow][cursor + dc] = label;
        }
      }
      cursor += colspan;
      maxCol = Math.max(maxCol, cursor);
    }
  }
  const labels: string[] = [];
  for (let col = 0; col < maxCol; col += 1) {
    const parts: string[] = [];
    for (const row of grid) {
      const value = row[col];
      if (value && value !== parts[parts.length - 1]) parts.push(value);
    }
    labels.push(parts.join(' / '));
  }
  return labels;
}

/**
 * 展开数据行（只展开 colspan；rowspan 由浏览器布局覆盖，不复制单元格值）。
 * 夹具里的 rowspan 行会自带补齐的单元格，因此按“原始单元格顺序”对齐才与 CLI/JS 口径一致。
 */
function expandBodyRows(rows: readonly ElementLike[], columnCount: number): string[][] {
  const out: string[][] = [];
  for (const row of rows) {
    const cells = cellsOf(row);
    if (!cells.length) continue;
    const line: string[] = [];
    for (const cell of cells) {
      const colspan = spanOf(cell, 'colspan');
      const text = readCellText(cell);
      for (let index = 0; index < colspan; index += 1) line.push(text);
    }
    const padded: string[] = [];
    for (let col = 0; col < columnCount; col += 1) padded.push(line[col] ?? '');
    out.push(padded);
  }
  return out;
}

/** 找到表格的表头行与数据行（HTML table 与 ARIA grid 统一处理）。 */
function readTableShape(table: ElementLike): { headerCount: number; rows: ElementLike[]; columns: string[] } {
  const rows = directRowsOf(table);
  if (!rows.length) return { headerCount: 0, rows: [], columns: [] };
  const headerRows: ElementLike[] = [];
  const dataRows: ElementLike[] = [];
  for (const row of rows) {
    const cells = cellsOf(row);
    if (!cells.length) continue;
    if (cells.every((cell) => isHeaderCell(cell))) headerRows.push(row);
    else dataRows.push(row);
  }
  if (headerRows.length) {
    const columns = expandHeaderLabels(headerRows);
    return { headerCount: headerRows.length, rows: dataRows, columns };
  }
  // ARIA grid 的 columnheader 可能不在 tr 里：直接用它们的文本作为列名。
  const looseHeaders = queryAll(table, '[role="columnheader"]');
  if (looseHeaders.length) {
    return {
      headerCount: 0,
      rows: dataRows.length ? dataRows : rows,
      columns: looseHeaders.slice(0, 64).map((header) => readCellText(header)),
    };
  }
  // 没有表头：用列号
  const first = dataRows[0] ?? rows[0];
  const count = first ? cellsOf(first).length : 1;
  const columns: string[] = [];
  for (let index = 0; index < Math.max(count, 1); index += 1) columns.push('列 ' + String(index + 1));
  return { headerCount: 0, rows: dataRows.length ? dataRows : rows, columns };
}

function columnKeys(count: number): ContentExtractColumn[] {
  const columns: ContentExtractColumn[] = [];
  for (let index = 0; index < count; index += 1) {
    columns.push({ key: 'c' + String(index + 1), label: '' });
  }
  return columns;
}

interface TablePayload {
  kind: 'table';
  id: string;
  label: string;
  columns: ContentExtractColumn[];
  rows: Array<Record<string, string | null>>;
  totalRows: number;
  rowCount: number;
}

function readTablePayload(table: ElementLike, id: string): TablePayload {
  const shape = readTableShape(table);
  const keys = columnKeys(shape.columns.length || 1);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (!key) continue;
    key.label = shape.columns[index] ?? key.label;
  }
  const matrix = expandBodyRows(shape.rows, keys.length);
  const rows: Array<Record<string, string | null>> = [];
  for (const cells of matrix) {
    if (rows.length >= MAX_EXTRACT_ROWS) break;
    if (!cells.some((cell) => cell.length > 0)) continue;
    const out: Record<string, string | null> = {};
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (!key) continue;
      out[key.key] = cells[index] ?? null;
    }
    rows.push(out);
  }
  return {
    kind: 'table',
    id,
    label: tableLabel(table),
    columns: keys,
    rows,
    totalRows: matrix.filter((cells) => cells.some((cell) => cell.length > 0)).length,
    rowCount: rows.length,
  };
}

function tableLabel(el: ElementLike): string {
  const bits: string[] = [];
  const aria = el.getAttribute('aria-label');
  if (aria) bits.push(aria);
  const caption = queryAll(el, 'caption')[0];
  if (caption) bits.push(normalizeText(caption.textContent));
  const id = el.id ? String(el.id) : '';
  if (id) bits.push('#' + id);
  const cls = el.getAttribute('class');
  if (cls) bits.push('.' + cls.trim().split(/\s+/).slice(0, 2).join('.'));
  return bits.filter(Boolean).join(' ') || roleOfElement(el) || 'table';
}

function isTableCandidate(el: ElementLike): boolean {
  const tag = tagOf(el);
  if (tag === 'TABLE') return true;
  const role = String(el.getAttribute('role') ?? '').toLowerCase();
  if (role === 'table' || role === 'grid' || role === 'treegrid') return true;
  return false;
}

function isListCandidate(el: ElementLike): boolean {
  const tag = tagOf(el);
  return tag === 'UL' || tag === 'OL' || String(el.getAttribute('role') ?? '').toLowerCase() === 'list';
}

interface ListShape {
  columns: ContentExtractColumn[];
  rows: Array<Record<string, string | null>>;
  totalRows: number;
}

export interface FieldSpec {
  key: string;
  read?: 'text' | 'value' | 'attribute' | 'html' | 'checked' | 'exists';
  attribute?: string | null;
}

/** 单字段读取（list 提取的字段映射；未识别的 read 回退为 text）。 */
function readFieldOf(item: ElementLike, spec: FieldSpec): string | null {
  const mode = spec.read ?? 'text';
  try {
    if (mode === 'value') {
      const value = (item as { value?: string }).value;
      return typeof value === 'string' ? value : normalizeText(item.textContent);
    }
    if (mode === 'html') return String(item.innerHTML ?? '').slice(0, 500);
    if (mode === 'checked') {
      const checked = (item as { checked?: boolean }).checked;
      return checked === true ? 'true' : 'false';
    }
    if (mode === 'exists') return 'true';
    if (mode === 'attribute') {
      const name = String(spec.attribute ?? '').trim();
      if (!name) return null;
      const value = item.getAttribute(name);
      return value === null ? null : String(value);
    }
    return normalizeText(item.textContent);
  } catch {
    return null;
  }
}

const DEFAULT_LIST_FIELDS: readonly FieldSpec[] = Object.freeze([
  { key: 'text', read: 'text' },
  { key: 'html', read: 'html' },
]);

function readListShape(container: ElementLike, itemSelector: string, fields: readonly FieldSpec[]): ListShape {
  const specs = fields.length ? fields : DEFAULT_LIST_FIELDS;
  const items = queryAll(container, itemSelector);
  const columns: ContentExtractColumn[] = specs.map((spec) => ({ key: spec.key, label: spec.key }));
  const rows: Array<Record<string, string | null>> = [];
  for (const item of items) {
    if (rows.length >= MAX_EXTRACT_ROWS) break;
    const row: Record<string, string | null> = {};
    for (const spec of specs) row[spec.key] = readFieldOf(item, spec);
    rows.push(row);
  }
  return { columns, rows, totalRows: items.length };
}

function findTargetById(env: DomEnvironment, id: string): { kind: 'table' | 'list'; element: ElementLike } | null {
  const all = queryAll(env.document.documentElement ?? env.document.body, '*');
  const tables: ElementLike[] = [];
  const lists: ElementLike[] = [];
  for (const el of all) {
    if (isTableCandidate(el)) tables.push(el);
    else if (isListCandidate(el) && queryAll(el, 'li').length >= 2) lists.push(el);
  }
  tables.sort((a, b) => tablePreference(b) - tablePreference(a));
  const index = Number(id);
  if (!Number.isInteger(index) || index < 0) return null;
  if (index < tables.length) {
    const table = tables[index];
    return table ? { kind: 'table', element: table } : null;
  }
  const listElement = lists[index - tables.length];
  return listElement ? { kind: 'list', element: listElement } : null;
}

function tablePreference(el: ElementLike): number {
  const rows = directRowsOf(el).length;
  return rows * 10 + (tagOf(el) === 'TABLE' ? 5 : 0);
}

export interface ExtractParams {
  mode?: 'auto' | 'discover' | 'table' | 'list';
  target?: string | null;
  ref?: string | null;
  selector?: string | null;
  itemSelector?: string | null;
  fields?: FieldSpec[];
}

/** 提取：discover 返回目标清单与预览；table/list/auto 返回结构化行列。 */
export function extractPage(env: DomEnvironment, refsByHandle: Map<string, ElementLike>, params: ExtractParams = {}): ContentExtractPayload {
  const doc = env.document;
  const root = doc.documentElement ?? doc.body ?? null;
  const mode = params.mode ?? 'auto';
  const base = {
    targets: [] as ContentExtractTarget[],
    frameCount: 1,
    framesScanned: 1,
    framesSeen: 1,
    limits: LIMITS,
    truncated: false,
    sourceLabel: '',
    totalTables: 0,
    fingerprint: domFingerprint(env),
  };
  if (mode === 'discover') {
    const all = queryAll(root, '*');
    const tables: ElementLike[] = [];
    const lists: ElementLike[] = [];
    for (const el of all) {
      if (isTableCandidate(el)) tables.push(el);
      else if (isListCandidate(el) && queryAll(el, 'li').length >= 2) lists.push(el);
    }
    tables.sort((a, b) => tablePreference(b) - tablePreference(a));
    const targets: ContentExtractTarget[] = [];
    let truncated = false;
    const pushTarget = (element: ElementLike, kind: 'table' | 'list', id: string): void => {
      if (targets.length >= MAX_EXTRACT_TARGETS) {
        truncated = true;
        return;
      }
      if (kind === 'table') {
        const payload = readTablePayload(element, id);
        targets.push({
          id,
          kind: 'table',
          frameId: 0,
          label: payload.label,
          columns: payload.columns.length,
          rowCount: payload.totalRows,
          preview: {
            columns: payload.columns.slice(0, PREVIEW_COLUMNS).map((column) => column.label || column.key),
            sample: payload.rows.slice(0, PREVIEW_SAMPLE),
          },
        });
      } else {
        const shape = readListShape(element, 'li', DEFAULT_LIST_FIELDS);
        targets.push({
          id,
          kind: 'list',
          frameId: 0,
          label: tableLabel(element),
          columns: shape.columns.length,
          rowCount: shape.totalRows,
          preview: {
            columns: shape.columns.slice(0, PREVIEW_COLUMNS).map((column) => column.label || column.key),
            sample: shape.rows.slice(0, PREVIEW_SAMPLE),
          },
        });
      }
    };
    for (let index = 0; index < tables.length; index += 1) {
      const table = tables[index];
      if (table) pushTarget(table, 'table', String(index));
    }
    for (let index = 0; index < lists.length; index += 1) {
      const list = lists[index];
      if (list) pushTarget(list, 'list', String(tables.length + index));
    }
    return {
      ...base,
      mode: 'discover',
      columns: [],
      rows: [],
      totalRows: 0,
      targets,
      truncated,
      totalTables: tables.length,
    };
  }

  if (mode === 'list') {
    const container = resolveTarget(doc, refsByHandle, { ref: params.ref ?? null, selector: params.selector ?? null }).element;
    const shape = readListShape(container, String(params.itemSelector ?? 'li'), params.fields ?? []);
    return {
      ...base,
      mode: 'list',
      columns: shape.columns,
      rows: shape.rows,
      totalRows: shape.totalRows,
      sourceLabel: 'list:' + String(params.selector ?? params.ref ?? ''),
      truncated: shape.totalRows > shape.rows.length,
    };
  }

  // table / auto：按 target → ref/selector → 最大表格/列表 的顺序解析
  let element: ElementLike | null = null;
  let label = '';
  let kind: 'table' | 'list' = 'table';
  if (params.target) {
    const found = findTargetById(env, String(params.target));
    if (!found) throw new PageError('E_NOT_FOUND', '提取目标不存在：' + String(params.target), { target: String(params.target) });
    element = found.element;
    kind = found.kind;
    label = 'target:' + String(params.target);
  } else if (params.ref || params.selector) {
    element = resolveTarget(doc, refsByHandle, { ref: params.ref ?? null, selector: params.selector ?? null }).element;
    label = String(params.selector ?? params.ref ?? '');
  } else {
    // auto：优先行数最多的 table，其次最长的列表
    const all = queryAll(root, '*');
    let best: ElementLike | null = null;
    let bestScore = 0;
    for (const el of all) {
      if (!isTableCandidate(el)) continue;
      const score = tablePreference(el);
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }
    if (best) {
      element = best;
      label = 'auto:' + tableLabel(best);
    } else {
      const lists = all.filter((el) => isListCandidate(el) && queryAll(el, 'li').length >= 2);
      lists.sort((a, b) => queryAll(b, 'li').length - queryAll(a, 'li').length);
      element = lists[0] ?? null;
      kind = 'list';
      label = element ? 'auto:list' : '';
    }
  }
  if (!element) throw new PageError('E_NOT_FOUND', '没有可提取的表格/列表目标');
  const actualKind = kind === 'table' && !isTableCandidate(element) ? 'list' : kind;
  if (actualKind === 'list') {
    const shape = readListShape(element, String(params.itemSelector ?? 'li'), params.fields ?? []);
    return {
      ...base,
      mode: 'auto',
      columns: shape.columns,
      rows: shape.rows,
      totalRows: shape.totalRows,
      sourceLabel: label,
      truncated: shape.totalRows > shape.rows.length,
    };
  }
  const payload = readTablePayload(element, '');
  return {
    ...base,
    mode: 'auto',
    columns: payload.columns,
    rows: payload.rows,
    totalRows: payload.totalRows,
    sourceLabel: label,
    truncated: payload.totalRows > payload.rows.length,
  };
}

// ---------------------------------------------------------------------------
// 网络只读视图（PerformanceResourceTiming）
// ---------------------------------------------------------------------------

function numberOrNull(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function deltaOrNull(start: unknown, end: unknown): number | null {
  const a = numberOrNull(start);
  const b = numberOrNull(end);
  if (a === null || b === null || b < a) return null;
  return Math.round(b - a);
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * 读取页面资源计时（只读）。
 *
 * 能拿到：URL、发起类型、开始时间、耗时、HTTP 状态（Chrome 109+ 的 responseStatus）、
 * 传输/解码字节、phase 计时。拿不到（因此字段为 null，并在 note 里说明）：
 * HTTP 方法、请求/响应头、请求体/响应体 —— 这些需要 chrome.debugger，本运行时明确不接。
 */
export function readResourceEntries(env: DomEnvironment): ContentNetworkEntriesResult {
  const performanceBag = env.window.performance;
  const now = Number(performanceBag?.now?.() ?? 0);
  const timeOrigin = Number(performanceBag?.timeOrigin ?? 0);
  const raw = performanceBag?.getEntriesByType?.('resource');
  const list = raw ? Array.from(raw) : [];
  const seen = list.length;
  const entries: ContentNetworkEntry[] = [];
  for (let index = 0; index < list.length; index += 1) {
    const entry = list[index] ?? {};
    const startTime = Number(entry.startTime);
    const duration = Number(entry.duration);
    const available = Number(entry.responseEnd ?? entry.startTime);
    entries.push({
      id: index + 1,
      url: stringOf(entry.name),
      initiatorType: stringOf(entry.initiatorType) || 'other',
      startedAt: Number.isFinite(startTime) ? Math.round(timeOrigin + startTime) : Math.round(timeOrigin),
      durationMs: Number.isFinite(duration) ? Math.round(duration * 1000) / 1000 : 0,
      status: numberOrNull(entry.responseStatus),
      transferSize: Number(entry.transferSize) || 0,
      encodedBodySize: Number(entry.encodedBodySize) || 0,
      decodedBodySize: Number(entry.decodedBodySize) || 0,
      fromCache: (Number(entry.transferSize) || 0) === 0 && (Number(entry.decodedBodySize) || 0) > 0,
      finished: duration > 0 && available > 0,
      timings: {
        redirectMs: deltaOrNull(entry.startTime, entry.redirectEnd),
        dnsMs: deltaOrNull(entry.domainLookupStart, entry.domainLookupEnd),
        connectMs: deltaOrNull(entry.connectStart, entry.connectEnd),
        tlsMs: deltaOrNull(entry.secureConnectionStart, entry.connectEnd),
        requestMs: deltaOrNull(entry.requestStart, entry.responseStart),
        ttfbMs: deltaOrNull(entry.requestStart, entry.responseStart),
        downloadMs: deltaOrNull(entry.responseStart, entry.responseEnd),
      },
    });
  }
  return {
    entries,
    url: String(env.document.URL ?? ''),
    timeOrigin,
    now,
    seen,
  };
}
