// src/content/dom.ts —— 页面侧最小动作实现（无 chrome.debugger，纯 DOM API）。
//
// 这是 M-C 第二批的关键取舍：JS 扩展的原生输入走 CDP（chrome.debugger），TS 运行时
// 本批明确不接 debugger（避免与 JS 扩展抢 attach），所以：
// - observe：把 DOM 走一遍，产出语义行 + `@eN` 短句柄，可见性用 computed style 判定；
// - click：ref/selector 解析 → elementFromPoint 命中校验 → el.click() 合成事件；
// - fill：原生 value setter（浏览器侧注入）+ input/change 事件 + 读回校验；
// - read/select/get-html：只读/薄动作，供动作面闭环。
// 所有证据字段如实标注 `trusted:false` / `synthetic:true` / `via:'content-script'`，
// 不把合成事件伪装成原生输入。
//
// 为了让这套逻辑在 Node（无 jsdom）里可单测，DOM 访问收窄成下面几个结构接口；
// 生产入口把真实 document/window 强制转型传进来，单测传最小 fake DOM。
// 刻意不声明 children/childNodes：真实 DOM 的 HTMLCollection 与数组不可互换，
// 平面遍历 querySelectorAll('*') 已经足够产出本批需要的信息。

import type {
  ContentClickResult,
  ContentEvaluateResult,
  ContentFillResult,
  ContentGetHtmlResult,
  ContentObserveRef,
  ContentObserveResult,
  ContentReadField,
  ContentReadResult,
  ContentSelectResult,
} from './protocol.ts';

export interface DomRectLike {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  /** 下沿（longshot 固定底带识别用；fake DOM 可不给，按 top+height 推导）。 */
  readonly bottom?: number;
}

export interface StyleLike {
  readonly display?: string;
  readonly visibility?: string;
  readonly opacity?: string;
  readonly pointerEvents?: string;
  /** 定位方式（长截图固定顶/底带识别用）。 */
  readonly position?: string;
  /** 以下字段供 VOM facts 抽取使用（滚动容器/cursor/层叠）；fake DOM 可选。 */
  readonly overflow?: string;
  readonly overflowX?: string;
  readonly overflowY?: string;
  readonly cursor?: string;
  readonly zIndex?: string;
}

/** 元素的最小结构接口（真实 Element 结构上兼容；fake DOM 实现它）。 */
export interface ElementLike {
  readonly tagName: string;
  readonly isConnected: boolean;
  readonly textContent?: string | null;
  readonly innerHTML?: string | null;
  readonly outerHTML?: string | null;
  readonly value?: string;
  readonly checked?: boolean;
  readonly disabled?: boolean;
  readonly type?: string;
  readonly id?: string;
  /** 父元素（深度计算/提取路径用；fake DOM 可选）。 */
  readonly parentElement?: ElementLike | null;
  /** 滚动尺寸（metrics/full-page 截图用；fake DOM 可选）。 */
  readonly scrollWidth?: number;
  readonly scrollHeight?: number;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  getBoundingClientRect(): DomRectLike;
  closest?(selector: string): ElementLike | null;
  contains?(other: ElementLike | null): boolean;
  querySelector?(selector: string): ElementLike | null;
  querySelectorAll?(selector: string): ArrayLike<ElementLike>;
  /** open shadow root（closed 读不到）；第四批 observe 会把 open shadow 内容并入语义树。 */
  readonly shadowRoot?: {
    querySelectorAll?(selector: string): ArrayLike<ElementLike>;
    host?: ElementLike | null;
  } | null;
  getRootNode?(): { host?: ElementLike | null } | null;
  scrollIntoView?(arg?: unknown): void;
  getClientRects?(): ArrayLike<DomRectLike>;
  focus?(): void;
  blur?(): void;
  click?(): void;
  dispatchEvent?(event: unknown): boolean;
}

export interface DocumentLike {
  readonly title?: string;
  readonly URL?: string;
  readonly documentElement?: ElementLike | null;
  readonly body?: ElementLike | null;
  readonly activeElement?: ElementLike | null;
  /** 文档是否真的有焦点（后台标签页/未聚焦窗口为 false；缺失视为 true）。 */
  hasFocus?(): boolean;
  createElement?(tag: string): ElementLike;
  elementFromPoint?(x: number, y: number): ElementLike | null;
  getElementById?(id: string): ElementLike | null;
  querySelector?(selector: string): ElementLike | null;
  querySelectorAll?(selector: string): ArrayLike<ElementLike>;
}

export interface WindowLike {
  getComputedStyle?(el: ElementLike): StyleLike;
  readonly innerWidth?: number;
  readonly innerHeight?: number;
  readonly scrollX?: number;
  readonly scrollY?: number;
  readonly devicePixelRatio?: number;
  scrollTo?(x: number, y: number): void;
  /** 资源计时入口（网络只读面用；fake DOM 可注入）。 */
  readonly performance?: {
    readonly timeOrigin?: number;
    now?(): number;
    getEntriesByType?(type: string): ArrayLike<Record<string, unknown>>;
  };
}

/** 页面侧环境：真实 document/window + 可注入的包装（setValue/createEvent 便于单测）。 */
export interface DomEnvironment {
  document: DocumentLike;
  window: WindowLike;
  /** 写表单值：浏览器侧用原生 setter（React 受控组件才会收到 input）；测试注入 spy。 */
  setValue?: (el: ElementLike, value: string) => void;
  /** 造事件：浏览器侧 new Event/new InputEvent；测试注入记录器。 */
  createEvent?: (type: string, init: Record<string, unknown>) => unknown;
  /** 有界等待（focus 后复核窗口；浏览器侧 setTimeout，测试可注入）。 */
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** 页面侧结构化错误：带 code/data，由内容脚本入口转成 ContentReply。 */
export class PageError extends Error {
  readonly code: string;
  readonly data: unknown;

  constructor(code: string, message: string, data?: unknown) {
    super(message);
    this.name = 'PageError';
    this.code = code;
    this.data = data;
  }

  toFailure(): { ok: false; code: string; message: string; data?: unknown } {
    return this.data === undefined
      ? { ok: false, code: this.code, message: this.message }
      : { ok: false, code: this.code, message: this.message, data: this.data };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// 原生 value setter
// ---------------------------------------------------------------------------

interface ValuePrototypeLike {
  readonly prototype: unknown;
}

/**
 * 用原型上的 value setter 写值。
 *
 * 为什么不能直接 `el.value = next`：React/Vue 的受控 input 用实例上的 value 追踪器
 * 拦截赋值，直接写实例属性不会触发框架的 onChange。JS 扩展的 fill 也是同一条思路。
 * Node 单测没有 HTMLInputElement，退回普通赋值（测试注入 setValue 覆盖）。
 */
export function setNativeValue(el: ElementLike, value: string): void {
  const target = el as { value?: string; tagName?: string };
  const g = globalThis as {
    HTMLInputElement?: ValuePrototypeLike;
    HTMLTextAreaElement?: ValuePrototypeLike;
  };
  const isTextarea = String(target.tagName ?? '').toUpperCase() === 'TEXTAREA';
  const ctor = isTextarea ? g.HTMLTextAreaElement : g.HTMLInputElement;
  try {
    const proto = ctor && ctor.prototype ? ctor.prototype : null;
    const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
    if (descriptor && typeof descriptor.set === 'function') {
      descriptor.set.call(el, value);
      return;
    }
  } catch {
    // 原型/描述符不可用（非浏览器或跨 realm）时退回普通赋值
  }
  target.value = value;
}

// ---------------------------------------------------------------------------
// 基础事实：文本/样式/可见性/角色/名称
// ---------------------------------------------------------------------------

/** 空白归一（保留非空内容；用于可访问名与文本证据）。 */
export function normalizeText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function tagOf(el: ElementLike): string {
  return String(el.tagName ?? '').toUpperCase();
}

export function styleOf(env: DomEnvironment, el: ElementLike): StyleLike {
  try {
    return env.window.getComputedStyle?.(el) ?? {};
  } catch {
    return {};
  }
}

/** 纯函数：样式层是否不可见（display/visibility/opacity）。 */
export function isHiddenByStyle(style: StyleLike | null | undefined): boolean {
  if (!style) return false;
  if (style.display === 'none') return true;
  if (style.visibility === 'hidden' || style.visibility === 'collapse') return true;
  const opacity = Number(style.opacity);
  if (Number.isFinite(opacity) && opacity <= 0.05) return true;
  return false;
}

const INPUT_ROLE_BY_TYPE: Readonly<Record<string, string>> = Object.freeze({
  text: 'textbox',
  search: 'searchbox',
  email: 'textbox',
  tel: 'textbox',
  url: 'textbox',
  password: 'textbox',
  number: 'spinbutton',
  date: 'textbox',
  'datetime-local': 'textbox',
  month: 'textbox',
  time: 'textbox',
  week: 'textbox',
  checkbox: 'checkbox',
  radio: 'radio',
  range: 'slider',
  file: 'file',
  submit: 'button',
  reset: 'button',
  button: 'button',
  image: 'button',
  color: 'color',
  hidden: '',
});

const TAG_ROLE: Readonly<Record<string, string>> = Object.freeze({
  A: 'link',
  BUTTON: 'button',
  TEXTAREA: 'textbox',
  SELECT: 'combobox',
  H1: 'heading',
  H2: 'heading',
  H3: 'heading',
  H4: 'heading',
  H5: 'heading',
  H6: 'heading',
  IMG: 'img',
  TABLE: 'table',
  UL: 'list',
  OL: 'list',
  LI: 'listitem',
  IFRAME: 'iframe',
  CANVAS: 'canvas',
  FORM: 'form',
  MAIN: 'main',
  NAV: 'navigation',
  SECTION: 'region',
  ARTICLE: 'article',
  ASIDE: 'complementary',
  HEADER: 'banner',
  FOOTER: 'contentinfo',
  DIALOG: 'dialog',
  VIDEO: 'video',
  AUDIO: 'audio',
  DETAILS: 'group',
  SUMMARY: 'button',
  PROGRESS: 'progressbar',
  METER: 'meter',
  TR: 'row',
  TD: 'cell',
  TH: 'columnheader',
});

/** 不参与观察输出的标签（脚本/样式/元数据/纯排版）。 */
const SKIPPED_TAGS: ReadonlySet<string> = new Set([
  'SCRIPT', 'STYLE', 'HEAD', 'META', 'LINK', 'TITLE', 'NOSCRIPT', 'TEMPLATE',
  'BR', 'HR', 'OPTION', 'OPTGROUP', 'THEAD', 'TBODY', 'TFOOT',
  'COLGROUP', 'COL', 'SOURCE', 'TRACK', 'PARAM', 'BASE',
]);

/** 可交互角色：只有这些节点分配 `@eN` 短句柄（与 JS observe 的 ref 口径一致）。 */
const ACTIONABLE_ROLES: ReadonlySet<string> = new Set([
  'button', 'textbox', 'searchbox', 'spinbutton', 'combobox', 'checkbox', 'radio',
  'slider', 'file', 'link', 'menuitem', 'tab', 'switch', 'option', 'treeitem',
  // 表格/网格的行与单元格是可读语义单元（E2E 的 row 级 ref / grid 单元格读取依赖）。
  'row', 'gridcell',
]);

export function isActionableRole(role: unknown): boolean {
  return typeof role === 'string' && ACTIONABLE_ROLES.has(role);
}

/** 显式 role 属性（多 token 取第一个；空字符串视为未设置）。 */
function explicitRole(el: ElementLike): string | null {
  const raw = el.getAttribute('role');
  if (typeof raw !== 'string') return null;
  const first = raw.trim().split(/\s+/)[0];
  return first ? first.toLowerCase() : null;
}

/** 元素 → aria role（显式 role 优先；input 按 type；其余按标签）。 */
export function roleOfElement(el: ElementLike): string | null {
  const explicit = explicitRole(el);
  if (explicit) return explicit;
  const tag = tagOf(el);
  if (tag === 'INPUT') {
    const type = String((el as { type?: string }).type ?? el.getAttribute('type') ?? 'text').toLowerCase();
    const role = INPUT_ROLE_BY_TYPE[type];
    return role === undefined ? 'textbox' : (role || null);
  }
  if (tag === 'A' && !el.hasAttribute('href')) return null;
  return TAG_ROLE[tag] ?? null;
}

/** 可访问名（aria-label > placeholder > alt > title > 文本 > name 属性）。 */
export function accessibleNameOf(el: ElementLike): string {
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel && normalizeText(ariaLabel)) return normalizeText(ariaLabel);
  const placeholder = el.getAttribute('placeholder');
  if (placeholder && normalizeText(placeholder)) return normalizeText(placeholder);
  const alt = el.getAttribute('alt');
  if (alt && normalizeText(alt)) return normalizeText(alt);
  const title = el.getAttribute('title');
  if (title && normalizeText(title)) return normalizeText(title);
  const text = normalizeText(el.textContent);
  if (text) return text.length > 120 ? text.slice(0, 120) : text;
  const name = el.getAttribute('name');
  if (name) return normalizeText(name);
  return '';
}

/** 纯函数：hit 与目标的关系（shadow DOM 的 host 回退单独标记）。 */
export function classifyHit(target: ElementLike, hit: ElementLike | null | undefined): 'self' | 'descendant' | 'host' | 'obstructed' {
  if (!hit) return 'obstructed';
  if (hit === target) return 'self';
  try {
    if (target.contains?.(hit)) return 'descendant';
    if (hit.contains?.(target)) return 'host';
  } catch {
    // contains 不可用时按遮挡处理
  }
  return 'obstructed';
}

/** 元素矩形（无 DOMRect 环境归 0；宽高取绝对值避免方向反转时为负）。 */
export function rectOf(el: ElementLike): { left: number; top: number; width: number; height: number } {
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

/** 纯函数：元素在当前环境下是否可观察（样式 + hidden/aria-hidden + 几何）。 */
export function isVisible(env: DomEnvironment, el: ElementLike): boolean {
  if (!el || el.isConnected === false) return false;
  if (el.hasAttribute('hidden')) return false;
  if (el.getAttribute('aria-hidden') === 'true') return false;
  if (isHiddenByStyle(styleOf(env, el))) return false;
  const rect = rectOf(el);
  return rect.width >= 1 && rect.height >= 1;
}

// ---------------------------------------------------------------------------
// observe
// ---------------------------------------------------------------------------

export interface ObservationOptions {
  /** 最多输出多少行（防超长页面拖垮 runtime 消息）。 */
  maxNodes?: number;
  /** 最多分配多少个 ref。 */
  maxRefs?: number;
  /** 观察文本字符上限。 */
  maxChars?: number;
  /** 最大输出深度（0 = 只输出文档根的直接子元素；越深越省略）。 */
  maxDepth?: number;
  /** 分页游标：跳过前 N 行（--cursor 续取）。 */
  offset?: number;
}

const DEFAULT_MAX_NODES = 800;
const DEFAULT_MAX_REFS = 400;
const DEFAULT_MAX_CHARS = 24_000;

export interface BuiltObservation {
  url: string;
  title: string;
  observation: string;
  refs: number;
  nodes: ContentObserveRef[];
  refsByHandle: Map<string, ElementLike>;
  filtered: number;
  truncated: boolean;
  depthOmitted: number;
  /** 本页实际起始行号（--cursor 分页）。 */
  offset: number;
  /** 本页输出的字符数。 */
  chars: number;
  /** 因预算被省略的字符数（--max-tokens 的 omitted 证据）。 */
  omittedChars: number;
}

function positiveLimit(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min) return fallback;
  return Math.min(Math.floor(number), max);
}

/** 元素的 DOM 深度（根为 0；parentElement 不可用时按 0 处理）。 */
function depthOf(el: ElementLike): number {
  let depth = 0;
  let current: ElementLike | null | undefined = el.parentElement;
  while (current && depth < 512) {
    depth += 1;
    current = current.parentElement;
  }
  return depth;
}

/** 链接目标的可读投影：`https://example.com/x` → `example.com/x`（相对链接原样保留）。 */
export function linkTargetDisplay(el: ElementLike): string | null {
  const raw = el.getAttribute('href');
  if (!raw) return null;
  try {
    const url = new URL(raw, 'https://relative.invalid/');
    if (url.host && url.host !== 'relative.invalid') return url.host + url.pathname + url.search;
    return raw;
  } catch {
    return raw;
  }
}

/** 容器的表头/列名文本（grid/table 的语义摘要；用于观察行可读性）。 */
function containerHeadersOf(el: ElementLike): string[] {
  const explicit = (() => {
    try {
      const list = el.querySelectorAll?.('[role="columnheader"]');
      return list ? Array.from(list).map((item) => normalizeText(item.textContent)).filter(Boolean) : [];
    } catch {
      return [];
    }
  })();
  if (explicit.length) return explicit.slice(0, 8);
  try {
    const headers = el.querySelectorAll?.('th');
    if (!headers) return [];
    return Array.from(headers).map((item) => normalizeText(item.textContent)).filter(Boolean).slice(0, 8);
  } catch {
    return [];
  }
}

/** VOM 语义标记（属性事实，不臆测）：expanded/has-submenu/draggable/drop-target/selected。 */
export function semanticMarkersOf(el: ElementLike, role: string): string[] {
  const markers: string[] = [];
  const ariaExpanded = el.getAttribute('aria-expanded');
  if (ariaExpanded === 'true') markers.push('expanded');
  const ariaPopup = el.getAttribute('aria-haspopup');
  if (ariaPopup !== null && ariaPopup !== 'false') markers.push('has-submenu');
  if (el.getAttribute('draggable') === 'true') markers.push('draggable');
  const className = String(el.getAttribute('class') ?? '');
  if (el.getAttribute('data-drag-handle') !== null || /(^|\s)drag-handle(\s|$)/i.test(className)) markers.push('drag-handle');
  if (el.getAttribute('data-drop-target') !== null || /(^|\s)drop-?(target|zone)(\s|$)/i.test(className)) markers.push('drop-target');
  if (/(^|\s)selected(\s|$)/i.test(className)) markers.push('selected:class');
  if (el.getAttribute('aria-selected') === 'true' || el.getAttribute('data-selected') !== null) markers.push('selected:data');
  void role;
  return markers.map((marker) => '[' + marker + ']');
}

/** 观察行：名字 + ref + 链接目标 + 容器表头 + 语义标记（全部来自页面事实）。 */
function observationLine(role: string, el: ElementLike, name: string, ref: string | null): string {
  let label = name;
  if (role === 'link') {
    const target = linkTargetDisplay(el);
    if (target) label = (label ? label + ' ' : '') + '→ ' + target;
  }
  if (role === 'grid' || role === 'table') {
    const headers = containerHeadersOf(el);
    if (headers.length) label = (label ? label + ' ' : '') + '(' + headers.join(' ') + ')';
  }
  const markers = semanticMarkersOf(el, role);
  return '- ' + role + (label ? ' "' + label + '"' : '') + (ref ? ' [' + ref + ']' : '') + (markers.length ? ' ' + markers.join(' ') : '');
}

/**
 * 把 DOM 走一遍产出 observe 结果。
 *
 * `refsByHandle` 是页面内的 ref → 元素表：动作命令随后按它解析 ref。
 * 空文本/被过滤的节点不占 ref 编号（编号只随输出行推进，保证观察文本与 ref 表一致）。
 * maxDepth 截断时追加一行显式提示（不静默丢内容）。
 */
export function buildObservation(
  env: DomEnvironment,
  options: ObservationOptions = {},
): BuiltObservation {
  const doc = env.document;
  const maxNodes = positiveLimit(options.maxNodes, DEFAULT_MAX_NODES, 20, 4000);
  const maxRefs = positiveLimit(options.maxRefs, DEFAULT_MAX_REFS, 10, 2000);
  const maxChars = positiveLimit(options.maxChars, DEFAULT_MAX_CHARS, 200, 200_000);
  const maxDepth = Number.isInteger(options.maxDepth) && Number(options.maxDepth) >= 0
    ? Math.min(Number(options.maxDepth), 200)
    : null;
  const skipLines = Number.isInteger(options.offset) && Number(options.offset) > 0 ? Math.floor(Number(options.offset)) : 0;
  const url = String(doc.URL ?? '');
  const title = String(doc.title ?? '');
  const refsByHandle = new Map<string, ElementLike>();
  const nodes: ContentObserveRef[] = [];
  const lines: string[] = [];
  let chars = 0;
  let filtered = 0;
  let truncated = false;
  let depthOmitted = 0;
  let emitted = 0;

  let all: ElementLike[] = [];
  try {
    const list = doc.querySelectorAll?.('*');
    if (list) all = Array.from(list);
  } catch {
    all = [];
  }
  // open shadow DOM：shadow 内元素不在 document.querySelectorAll('*') 里，单独并入观察
  // （closed shadow 无法从页面读到，如实缺席；20v 的 closedShadow 能力仍未迁移）。
  const shadowQueue = all.slice();
  while (shadowQueue.length) {
    const current = shadowQueue.shift();
    if (!current) break;
    const root = current.shadowRoot;
    if (!root || typeof root.querySelectorAll !== 'function') continue;
    try {
      const inner = root.querySelectorAll('*');
      if (inner) {
        for (const item of Array.from(inner)) {
          all.push(item);
          shadowQueue.push(item);
        }
      }
    } catch {
      // 读 shadow 失败时跳过（不影响主文档观察）
    }
  }

  let omittedChars = 0;
  let counting = false;

  for (const el of all) {
    if (!counting && (emitted >= maxNodes || chars >= maxChars)) {
      // 已经超出预算：后续只统计“被省略的字符数”（供 --max-tokens 的 omitted 证据），
      // 不再分配 ref、不再输出行。
      truncated = true;
      counting = true;
    }
    const tag = tagOf(el);
    if (!tag || SKIPPED_TAGS.has(tag)) {
      filtered += 1;
      continue;
    }
    if (maxDepth !== null && depthOf(el) > maxDepth) {
      depthOmitted += 1;
      filtered += 1;
      continue;
    }
    const role = roleOfElement(el);
    if (!role) {
      filtered += 1;
      continue;
    }
    if (!isVisible(env, el)) {
      filtered += 1;
      continue;
    }
    const name = accessibleNameOf(el);
    let ref: string | null = null;
    if (!counting) {
      const actionable = isActionableRole(role) && refsByHandle.size < maxRefs;
      if (actionable) {
        ref = '@e' + (refsByHandle.size + 1);
        refsByHandle.set(ref, el);
        nodes.push({ ref, role, name: name || null, tag: tag.toLowerCase(), id: el.id ? String(el.id) : null });
      }
    }
    const line = observationLine(role, el, name, ref);
    // 分页游标：只跳过输出行，不跳过 ref 分配（保持 ref 编号与整页一致）。
    if (skipLines > 0 && emitted < skipLines) {
      emitted += 1;
      continue;
    }
    if (counting) {
      if (omittedChars < 200_000) omittedChars += line.length + 1;
      continue;
    }
    if (chars + line.length > maxChars) {
      truncated = true;
      counting = true;
      if (lines.length === 0) {
        // 单行就超过预算：截断这一行也要输出（否则分页游标永远不会推进）。
        const sliced = line.slice(0, Math.max(40, maxChars));
        lines.push(sliced);
        chars += sliced.length + 1;
        emitted += 1;
      } else {
        omittedChars += line.length + 1;
      }
      continue;
    }
    chars += line.length + 1;
    lines.push(line);
    emitted += 1;
  }

  if (depthOmitted > 0) {
    lines.push('- （截断更深层 ' + String(depthOmitted) + ' 个节点，--max-depth 生效）');
  }

  const observation = lines.join('\n');
  return {
    url,
    title,
    observation,
    refs: nodes.length,
    nodes,
    refsByHandle,
    filtered,
    truncated,
    depthOmitted,
    offset: skipLines,
    chars,
    omittedChars,
  };
}

// ---------------------------------------------------------------------------
// 目标解析与动作
// ---------------------------------------------------------------------------

export interface TargetSpec {
  ref?: string | null;
  selector?: string | null;
}

export interface ResolvedTarget {
  element: ElementLike;
  ref: string | null;
  selector: string | null;
}

function unquote(value: string): string {
  return value.replace(/^['"]|['"]$/g, '');
}

/**
 * 解析动作目标：ref 走页面内 ref 表（失效回 E_STALE_REF），selector 走主文档。
 * 两者必须且只能给一个（与 CLI/daemon 的参数契约一致）。
 */
export function resolveTarget(
  doc: DocumentLike,
  refsByHandle: Map<string, ElementLike>,
  spec: TargetSpec,
): ResolvedTarget {
  const ref = typeof spec.ref === 'string' && spec.ref ? spec.ref : null;
  const selector = typeof spec.selector === 'string' && spec.selector ? spec.selector : null;
  if (ref && selector) throw new PageError('E_BAD_ARG', 'ref 与 selector 只能给一个');
  if (ref) {
    const element = refsByHandle.get(ref);
    if (!element) throw new PageError('E_STALE_REF', 'ref ' + ref + ' 不在当前 ref 表里，请重新 observe', { ref });
    if (element.isConnected === false) {
      throw new PageError('E_STALE_REF', 'ref ' + ref + ' 指向的元素已不在文档里，请重新 observe', { ref });
    }
    return { element, ref, selector: null };
  }
  if (!selector) throw new PageError('E_BAD_ARG', '动作需要 ref 或 selector');
  let element: ElementLike | null = null;
  try {
    element = doc.querySelector?.(selector) ?? null;
  } catch (error) {
    throw new PageError('E_BAD_ARG', 'selector 不合法：' + (error instanceof Error ? error.message : String(error)), { selector });
  }
  if (!element) throw new PageError('E_NOT_FOUND', '没有找到 selector 对应的元素：' + selector, { selector });
  return { element, ref: null, selector };
}

export interface ClickOptions {
  /** 命中测试失败时是否仍然点击（默认 false：宁可失败也不误点）。 */
  force?: boolean;
  /** 拟人输入：先派发多段 mousemove（--human；合成事件，证据 trusted:false）。 */
  human?: boolean;
  /** focus 后复核窗口（毫秒）：默认 20，上限 50；0 = 只做同步复核。 */
  settleAfterFocusMs?: number;
  /** Agent 派发窗口回调（协作归因时钟）：派发前后各调用一次。 */
  onAgentDispatch?: (phase: 'begin' | 'end', kind: string) => void;
}

/** 元素是否位于 shadow tree 内（shadow 内的 elementFromPoint 会被 retarget 到 host）。 */
export function isInShadowTree(el: ElementLike): boolean {
  try {
    const root = el.getRootNode?.();
    return Boolean(root && (root as { host?: unknown }).host);
  } catch {
    return false;
  }
}

/** 拟人轨迹：在目标附近派发多段 mousemove（页面能观察到轨迹；不是原生输入）。 */
function dispatchHumanTrack(env: DomEnvironment, el: ElementLike, x: number, y: number): void {
  const steps = 5;
  for (let index = 1; index <= steps; index += 1) {
    const px = x - 40 + (40 * index) / steps;
    const py = y - 24 + (24 * index) / steps;
    let event: unknown = null;
    try {
      event = env.createEvent?.('mousemove', {
        bubbles: true,
        cancelable: true,
        clientX: px,
        clientY: py,
        view: env.window,
      }) ?? null;
    } catch {
      event = null;
    }
    if (!event) continue;
    try {
      el.dispatchEvent?.(event);
    } catch {
      // 页面监听器抛错不影响点击
    }
  }
}

/**
 * 动作前目标身份校验（对齐 JS 0.3.0 `injected/parts/50-visual.part` 的 actionClick）：
 * focus 之后目标被替换/脱离文档时必须 fail closed —— 不把旧动作重放到新节点。
 *
 * 证据口径与 action-receipt 一致：`receipt.effectState='unknown'`（动作没有派发，
 * 但也不能断言页面一定没变化），且 `replay:false` 明确“不重放”。
 */
export function assertTargetStillCurrent(env: DomEnvironment, resolved: ResolvedTarget, method = 'click'): void {
  const el = resolved.element;
  if (resolved.selector && !resolved.ref) {
    let current: ElementLike | null = null;
    try {
      current = env.document.querySelector?.(resolved.selector) ?? null;
    } catch {
      current = null;
    }
    if (current && current !== el) throw targetReplacedError(method, resolved, 'selector-replaced');
  }
  if (el.isConnected === false) throw targetReplacedError(method, resolved, 'detached');
}

/** focus 后复核窗口的默认/上限（毫秒）：有界，绝不做无界等待。 */
export const FOCUS_SETTLE_MS = 20;
export const FOCUS_SETTLE_MAX_MS = 50;

function resolveSettleMs(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return FOCUS_SETTLE_MS;
  return Math.min(Math.floor(value), FOCUS_SETTLE_MAX_MS);
}

/** 有界等待（测试可注入 `env.wait`，生产用 setTimeout）。 */
export function settleAfterFocus(env: DomEnvironment, ms: number): Promise<void> {
  const waitMs = Math.max(0, Math.min(Math.floor(ms), FOCUS_SETTLE_MAX_MS));
  if (waitMs === 0) return Promise.resolve();
  if (typeof env.wait === 'function') {
    try {
      return Promise.resolve(env.wait(waitMs));
    } catch {
      return Promise.resolve();
    }
  }
  return new Promise<void>((resolve) => setTimeout(resolve, waitMs));
}

/** 文档当前是否真的“有焦点”（后台标签页/未聚焦窗口为 false）。 */
export function documentHasFocus(env: DomEnvironment): boolean {
  try {
    const hasFocus = (env.document as { hasFocus?: unknown }).hasFocus;
    if (typeof hasFocus !== 'function') return true;
    return (hasFocus as () => unknown).call(env.document) !== false;
  } catch {
    return true;
  }
}

/**
 * 聚焦目标并让页面的 focus 处理器有机会执行。
 *
 * 实测（Edge 158 / Chromium）：在**没有焦点的文档**里 `el.focus()` 仍会改
 * `document.activeElement`，但**不派发** focus/focusin 事件；页面“focus 时替换目标”
 * 的行为不会发生，动作会落到旧节点上（35d E2E 的真实失败原因）。此时补发一次合成
 * focus/focusin，让页面在同一复核窗口内跑完 focus 副作用（focused 文档不会重复派发）。
 */
export function focusTarget(env: DomEnvironment, resolved: ResolvedTarget): void {
  const el = resolved.element;
  try {
    el.focus?.();
  } catch {
    // focus 失败不阻塞后续复核
  }
  if (documentHasFocus(env)) return;
  for (const type of ['focusin', 'focus'] as const) {
    let event: unknown = null;
    try {
      event = env.createEvent?.(type, { bubbles: type === 'focusin', cancelable: false, composed: true }) ?? null;
    } catch {
      event = null;
    }
    if (!event) continue;
    try {
      el.dispatchEvent?.(event);
    } catch {
      // 页面事件处理器抛错不影响后续复核（真实 focus 事件同样不会向外抛）
    }
  }
}

function targetReplacedError(method: string, resolved: ResolvedTarget, cause: string): PageError {
  return new PageError(
    'E_NOT_ACTIONABLE',
    '目标在动作前被替换（' + cause + '），未重放' + method,
    {
      reason: 'target-replaced',
      cause,
      ref: resolved.ref,
      selector: resolved.selector,
      effectState: 'unknown',
      effect_state: 'unknown',
      dispatched: false,
      replay: false,
      receipt: {
        method,
        ref: resolved.ref,
        frameId: 0,
        revision: 0,
        effectState: 'unknown',
        ...(resolved.selector ? { target: { selector: resolved.selector } } : {}),
        recovery: 'observe --force',
        cleanupState: 'failed',
        replay: false,
        cause,
      },
    },
  );
}

/**
 * click：命中测试 → 聚焦 + 有界复核（同步替换立即 fail closed；异步替换在 ≤50ms 窗口内
 * 再复核一次）→（可选拟人轨迹）→ 合成 click。
 */
export async function clickElement(env: DomEnvironment, resolved: ResolvedTarget, options: ClickOptions = {}): Promise<ContentClickResult> {
  options.onAgentDispatch?.('begin', options.human ? 'pointer-human' : 'pointer');
  try {
    return await clickElementInner(env, resolved, options);
  } finally {
    options.onAgentDispatch?.('end', options.human ? 'pointer-human' : 'pointer');
  }
}

async function clickElementInner(env: DomEnvironment, resolved: ResolvedTarget, options: ClickOptions): Promise<ContentClickResult> {
  const el = resolved.element;
  try {
    el.scrollIntoView?.({ block: 'center', inline: 'center' });
  } catch {
    // 滚动失败不影响点击（元素可能已经在视口里）
  }
  const rect = rectOf(el);
  if (rect.width <= 0 || rect.height <= 0) {
    throw new PageError('E_NOT_ACTIONABLE', '目标尺寸为 0，无法点击', { reason: 'zero-size', ...rect });
  }
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  let hit: ElementLike | null = null;
  try {
    hit = env.document.elementFromPoint?.(x, y) ?? null;
  } catch {
    hit = null;
  }
  // shadow tree 内的目标：document.elementFromPoint 返回 host（retarget），不能据此判遮挡；
  // 目标在 shadow 里时按命中 host/self 处理，不谎报为普通命中（证据里 via 仍是 content-script）。
  const shadowTarget = isInShadowTree(el);
  const rawRelation = classifyHit(el, hit);
  const relation = shadowTarget && rawRelation === 'obstructed' ? 'host' : rawRelation;
  if (relation === 'obstructed' && options.force !== true) {
    throw new PageError('E_NOT_ACTIONABLE', '点击点被其它元素遮挡，拒绝点击（可用 force 跳过）', {
      reason: 'obstructed',
      x,
      y,
      hitTag: hit ? tagOf(hit).toLowerCase() : null,
      hitId: hit && hit.id ? String(hit.id) : null,
    });
  }
  // 安全契约（35d）：动作前目标被替换就 fail closed，不把旧动作重放到新节点。
  // 1) 同步复核：focus 处理器里同步 replaceWith/remove 立即被抓住（也覆盖后台文档补发的
  //    合成 focus 事件）；
  // 2) 有界异步复核：页面在 focus 处理器里用 setTimeout/微任务延迟替换时，等待
  //    ≤50ms（默认 20ms，与 JS 参考 actionClick 的 sleep 同量级）再复核一次，绝不无界等待。
  focusTarget(env, resolved);
  assertTargetStillCurrent(env, resolved, 'click');
  await settleAfterFocus(env, resolveSettleMs(options.settleAfterFocusMs));
  assertTargetStillCurrent(env, resolved, 'click');
  if (options.human === true) dispatchHumanTrack(env, el, x, y);
  if (typeof el.click !== 'function') {
    throw new PageError('E_NOT_ACTIONABLE', '目标元素不支持 click()', { tag: tagOf(el).toLowerCase() });
  }
  el.click();
  return {
    ok: true,
    ref: resolved.ref,
    selector: resolved.selector,
    tag: tagOf(el).toLowerCase(),
    x,
    y,
    via: 'content-script',
    hit: relation === 'obstructed' ? 'self' : relation,
    isConnected: el.isConnected !== false,
    trusted: false,
    synthetic: true,
  };
}

/** 按可见文本/index 找目标（CLI --text 路径；只在动作角色里找，避免命中容器）。 */
export function findByText(env: DomEnvironment, text: unknown): ElementLike | null {
  const wanted = normalizeText(text);
  if (!wanted) return null;
  let all: ElementLike[] = [];
  try {
    const list = env.document.querySelectorAll?.('*');
    if (list) all = Array.from(list);
  } catch {
    all = [];
  }
  let fallback: ElementLike | null = null;
  for (const el of all) {
    if (el.isConnected === false) continue;
    const role = roleOfElement(el);
    if (!role) continue;
    const name = accessibleNameOf(el);
    const ownText = normalizeText(el.textContent);
    if (name !== wanted && ownText !== wanted) continue;
    if (!isVisible(env, el)) continue;
    if (isActionableRole(role)) return el;
    if (!fallback) fallback = el;
  }
  return fallback;
}

function dispatchPageEvent(env: DomEnvironment, el: ElementLike, type: string, init: Record<string, unknown>): void {
  let event: unknown = null;
  try {
    event = env.createEvent?.(type, { bubbles: true, cancelable: true, composed: true, ...init }) ?? null;
  } catch {
    event = null;
  }
  if (event && typeof el.dispatchEvent === 'function') {
    try {
      el.dispatchEvent(event);
    } catch {
      // 页面事件处理器抛错不应把动作变成失败（浏览器里事件派发不会向外抛）
    }
  }
}

export interface FillOptions {
  noClear?: boolean;
}

/** fill 不适用的 input 类型（复选框/文件/按钮类请用 click/upload）。 */
const NON_FILLABLE_INPUT_TYPES: ReadonlySet<string> = new Set([
  'checkbox', 'radio', 'file', 'submit', 'button', 'reset', 'image', 'range', 'color', 'hidden',
]);

/** fill：原生 setter 写值 + input/change + 读回校验。 */
export function fillElement(env: DomEnvironment, resolved: ResolvedTarget, value: unknown, options: FillOptions = {}): ContentFillResult {
  const el = resolved.element;
  const tag = tagOf(el);
  const editable = tag === 'INPUT' || tag === 'TEXTAREA'
    || (el.hasAttribute('contenteditable') && el.getAttribute('contenteditable') !== 'false');
  if (!editable) {
    throw new PageError('E_NOT_ACTIONABLE', '目标不是可填写的输入元素', { tag: tag.toLowerCase(), reason: 'not-editable' });
  }
  if (tag === 'INPUT') {
    const type = String((el as { type?: string }).type ?? el.getAttribute('type') ?? 'text').toLowerCase();
    if (NON_FILLABLE_INPUT_TYPES.has(type)) {
      throw new PageError('E_NOT_ACTIONABLE', '该 input 类型不能用 fill（请用 click/upload）：' + type, {
        tag: 'input',
        type,
        reason: 'unsupported-input-type',
      });
    }
  }
  if ((el as { disabled?: boolean }).disabled === true) {
    throw new PageError('E_NOT_ACTIONABLE', '目标元素已禁用', { tag: tag.toLowerCase(), reason: 'disabled' });
  }
  if (el.getAttribute('readonly') !== null) {
    throw new PageError('E_NOT_ACTIONABLE', '目标元素是只读的', { tag: tag.toLowerCase(), reason: 'readonly' });
  }
  const expected = String(value ?? '');
  const isContentEditable = tag !== 'INPUT' && tag !== 'TEXTAREA';
  const current = isContentEditable ? normalizeText(el.textContent) : String((el as { value?: string }).value ?? '');
  const next = options.noClear === true ? current + expected : expected;
  if (isContentEditable) {
    (el as { textContent?: string | null }).textContent = next;
  } else if (env.setValue) {
    env.setValue(el, next);
  } else {
    setNativeValue(el, next);
  }
  dispatchPageEvent(env, el, 'input', { inputType: 'insertText', data: next });
  dispatchPageEvent(env, el, 'change', {});
  const actual = isContentEditable
    ? normalizeText(el.textContent)
    : String((el as { value?: string }).value ?? '');
  return {
    ok: true,
    ref: resolved.ref,
    selector: resolved.selector,
    tag: tag.toLowerCase(),
    expected_value: next,
    actual_value: actual,
    matches: actual === next,
    cleared: options.noClear !== true,
    via: 'content-script',
    trusted: false,
    synthetic: true,
  };
}

// ---------------------------------------------------------------------------
// read / select / get-html / evaluate
// ---------------------------------------------------------------------------

function readOneField(el: ElementLike, key: string, attribute: string | null): ContentReadField {
  const tag = tagOf(el).toLowerCase();
  const type = el.getAttribute('type');
  const attributes: Record<string, string | null> = {};
  if (attribute) attributes[attribute] = el.getAttribute(attribute);
  const text = normalizeText(el.textContent).slice(0, 500) || null;
  const rawValue = (el as { value?: string }).value;
  return {
    key,
    tag,
    type,
    text,
    // 非表单元素没有 value 属性：退化为文本（E2E 会 read 行/链接/单元格的 ref，
    // 期望拿到可读内容而不是 null；与 JS read 的口径一致）。
    value: typeof rawValue === 'string' ? rawValue : text,
    checked: typeof (el as { checked?: boolean }).checked === 'boolean' ? Boolean((el as { checked?: boolean }).checked) : null,
    ...(attribute ? { attributes } : {}),
  };
}

export interface ReadOptions {
  /** true 时枚举主文档全部可读字段（read --all）。 */
  all?: boolean;
  key?: string;
  attribute?: string | null;
  limit?: number;
}

export function readFields(env: DomEnvironment, resolved: ResolvedTarget | null, options: ReadOptions = {}): ContentReadResult {
  const key = typeof options.key === 'string' && options.key ? options.key : 'value';
  const attribute = typeof options.attribute === 'string' && options.attribute ? options.attribute : null;
  if (resolved) {
    return {
      fields: [readOneField(resolved.element, key, attribute)],
      ref: resolved.ref,
      selector: resolved.selector,
      count: 1,
    };
  }
  if (options.all !== true) throw new PageError('E_BAD_ARG', 'read 需要 ref/selector，或 --all');
  const limit = positiveLimit(options.limit, 500, 1, 2000);
  let list: ArrayLike<ElementLike> | null = null;
  try {
    list = env.document.querySelectorAll?.('input,textarea,select,[contenteditable]') ?? null;
  } catch {
    list = null;
  }
  const fields: ContentReadField[] = [];
  if (list) {
    for (const el of Array.from(list)) {
      if (fields.length >= limit) break;
      if (el.isConnected === false) continue;
      if (!isVisible(env, el)) continue;
      fields.push(readOneField(el, key, attribute));
    }
  }
  return { fields, ref: null, selector: null, count: fields.length };
}

/** select：按 option value 匹配（其次按文本），写值后派发 input/change。 */
export function selectOption(env: DomEnvironment, resolved: ResolvedTarget, value: unknown): ContentSelectResult {
  const el = resolved.element;
  if (tagOf(el) !== 'SELECT') {
    throw new PageError('E_NOT_ACTIONABLE', '目标不是 select 元素', { tag: tagOf(el).toLowerCase() });
  }
  const expected = String(value ?? '');
  const options = (() => {
    try {
      return el.querySelectorAll?.('option') ? Array.from(el.querySelectorAll('option') as ArrayLike<ElementLike>) : [];
    } catch {
      return [];
    }
  })();
  const values = options.map((option) => String((option as { value?: string }).value ?? option.getAttribute('value') ?? ''));
  const texts = options.map((option) => normalizeText(option.textContent));
  let chosen = expected;
  if (!values.includes(expected)) {
    const byText = options.find((_option, index) => texts[index] === normalizeText(expected));
    if (byText) {
      chosen = String((byText as { value?: string }).value ?? byText.getAttribute('value') ?? '');
    } else {
      throw new PageError('E_OPTION_NOT_FOUND', 'select 里没有 value/text 匹配的选项：' + expected, {
        available: values.slice(0, 12),
      });
    }
  }
  if (env.setValue) env.setValue(el, chosen);
  else (el as { value?: string }).value = chosen;
  dispatchPageEvent(env, el, 'input', {});
  dispatchPageEvent(env, el, 'change', {});
  const actual = String((el as { value?: string }).value ?? '');
  return {
    ok: true,
    ref: resolved.ref,
    selector: resolved.selector,
    expected_value: chosen,
    actual_value: actual,
    matches: actual === chosen,
    via: 'content-script',
  };
}

/** get-html：返回目标内部 HTML（ref/selector 都可；无目标时返回整页 outerHTML）。 */
export interface GetHtmlOptions {
  /** 返回 outerHTML（整页/元素外部 HTML）而不是 innerHTML。 */
  outer?: boolean;
  /** 字符上限；超限截断并标记 truncated（默认 200k 字符）。 */
  maxChars?: number;
}

const DEFAULT_HTML_MAX_CHARS = 200_000;

/** 截断 HTML 并给出原始长度（不静默丢内容）。 */
export function clipHtml(html: unknown, maxChars: unknown): { html: string; truncated: boolean; fullLength: number } {
  const text = String(html ?? '');
  const limit = Number.isFinite(Number(maxChars)) && Number(maxChars) > 0
    ? Math.min(Math.floor(Number(maxChars)), 8 * 1024 * 1024)
    : DEFAULT_HTML_MAX_CHARS;
  if (text.length <= limit) return { html: text, truncated: false, fullLength: text.length };
  return { html: text.slice(0, limit), truncated: true, fullLength: text.length };
}

/** 元素子树元素数量（截断到 10000，避免超长页面卡住内容脚本）。 */
function descendantCount(el: ElementLike): number {
  try {
    const all = el.querySelectorAll?.('*');
    return all ? Math.min(Array.from(all).length, 10_000) : 0;
  } catch {
    return 0;
  }
}

export function getHtmlOf(resolved: ResolvedTarget | null, env?: DomEnvironment, options: GetHtmlOptions = {}): ContentGetHtmlResult {
  const doc = env?.document ?? null;
  const target = resolved?.element ?? (options.outer === true || !resolved ? doc?.documentElement ?? null : null);
  if (!target) throw new PageError('E_BAD_ARG', 'get-html 需要 ref/selector，或可读的文档根元素');
  const html = (() => {
    try {
      if (options.outer === true) {
        const outer = (target as { outerHTML?: string | null }).outerHTML;
        if (typeof outer === 'string') return outer;
        return String(doc?.documentElement?.outerHTML ?? '');
      }
      return String(target.innerHTML ?? '');
    } catch {
      return '';
    }
  })();
  const clipped = clipHtml(html, options.maxChars);
  const rect = rectOf(target);
  const facts = env ? {
    visible: isVisible(env, target),
    rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    role: roleOfElement(target),
    name: accessibleNameOf(target) || null,
    attached: target.isConnected !== false,
    descendants: descendantCount(target),
  } : undefined;
  return {
    html: clipped.html,
    tag: tagOf(target).toLowerCase(),
    ref: resolved?.ref ?? null,
    selector: resolved?.selector ?? null,
    ...(options.outer === true ? { outer: true } : {}),
    truncated: clipped.truncated,
    fullLength: clipped.fullLength,
    ...(facts ? { facts } : {}),
  };
}

/** 把 evaluate 的任意返回值收敛成可跨进程传输的 JSON 值。 */
export function jsonSafe(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') return value;
  if (type === 'bigint') return String(value);
  if (type === 'function' || type === 'symbol') return null;
  if (type === 'object') {
    if (depth > 6) return '[max-depth]';
    if (Array.isArray(value)) return value.slice(0, 1000).map((item) => jsonSafe(item, depth + 1));
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (count >= 200) break;
      out[key] = jsonSafe(item, depth + 1);
      count += 1;
    }
    return out;
  }
  return null;
}

/** evaluate：在内容脚本隔离世界执行表达式（不碰页面主世界，也不走 CDP）。 */
export function evaluateExpression(expression: unknown): ContentEvaluateResult {
  const text = typeof expression === 'string' ? expression.trim() : '';
  if (!text) throw new PageError('E_BAD_ARG', 'evaluate 需要非空 expression');
  const evaluator = (globalThis as { eval?: (source: string) => unknown }).eval;
  if (typeof evaluator !== 'function') {
    throw new PageError('E_EVAL_UNAVAILABLE', '内容脚本环境没有 eval，无法执行表达式');
  }
  let value: unknown;
  try {
    value = evaluator(text);
  } catch (error) {
    throw new PageError('E_EVAL_FAILED', 'evaluate 抛错：' + (error instanceof Error ? error.message : String(error)), {
      expression: text,
    });
  }
  return { value: jsonSafe(value), expression: text, world: 'content-script' };
}

/** 页面 URL/标题（供 observe 与 ping 复用；title 可能为空）。 */
export function pageInfo(env: DomEnvironment): { url: string; title: string } {
  return { url: String(env.document.URL ?? ''), title: String(env.document.title ?? '') };
}

export { isRecord };
