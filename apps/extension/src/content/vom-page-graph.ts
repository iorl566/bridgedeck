// src/content/vom-page-graph.ts —— 页面侧元素级关系图（DOM → raw graph）与 AX 投影。
//
// 源语义（只读参考）：
// - extension/injected/parts/31-graph-format.part 的 recordElementGraph：child 边、label /
//   html-for 边、form 边、ARIA 关系边（controls/tab-controls/owns/labelledby/describedby/
//   errormessage），以及 iframe 的 frameIndex/srcUrl 事实；
// - extension/injected/parts/26-action-graph.part / lib/ax-graph.js：AX 父子边（TS 没有 CDP AX
//   树，这里用 DOM 祖先投影，并给没有观察节点的 AX 根补 `ax:<id>` 上下文节点）。
//
// 原始图（key/parentKey）交给 packages/vom 的 buildVomGraph 归一成公开图（单一实现）；
// 本文件只负责把 DOM 事实抽成 raw graph，不做 affordance/关系判定。

import type { VomAxProjectionNode, VomGraphRawFacts, VomGraphRawNode } from '../../../../packages/vom/src/graph.ts';
import { VOM_GRAPH_DEFAULT_LIMITS } from '../../../../packages/vom/src/graph.ts';
import { roleOfElement, tagOf, type ElementLike } from './dom.ts';

/** 进入页面图的标签（其余是脚本/样式/元数据/纯排版，与 observe 语义树一致）。 */
const GRAPH_SKIPPED_TAGS: ReadonlySet<string> = new Set([
  'SCRIPT', 'STYLE', 'HEAD', 'META', 'LINK', 'TITLE', 'NOSCRIPT', 'TEMPLATE',
  'BR', 'HR', 'OPTION', 'OPTGROUP', 'THEAD', 'TBODY', 'TFOOT', 'COLGROUP', 'COL',
  'SOURCE', 'TRACK', 'PARAM', 'BASE',
]);

/** 可被 label 关联的表单控件（与 HTML labelable elements 一致）。 */
const LABELABLE_TAGS: ReadonlySet<string> = new Set([
  'INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'METER', 'OUTPUT', 'PROGRESS', 'KEYGEN',
]);

/** 图节点/边上限（与 packages/vom 的默认值一致）。 */
export const VOM_PAGE_GRAPH_LIMITS: Readonly<{ nodes: number; edges: number }> = Object.freeze({
  nodes: VOM_GRAPH_DEFAULT_LIMITS.nodes,
  edges: VOM_GRAPH_DEFAULT_LIMITS.edges,
});

/** 页面图构建输入。 */
export interface VomPageGraphSource {
  url: string;
  collected: ReadonlyArray<{ el: ElementLike; order: number }>;
  /** 元素 → rich 节点 id（rich.assignRichElementIds 的结果）。 */
  elementById: ReadonlyMap<ElementLike, string>;
  /** rich 节点 id → @eN ref（观察到的可动作节点才有）。 */
  refByNodeId: ReadonlyMap<string, string>;
  /** 文档级 iframe 清单（frameIndex 语义：document.querySelectorAll('iframe') 的下标）。 */
  iframeElements?: ReadonlyArray<ElementLike> | null;
  limits?: { nodes?: number; edges?: number };
}

function absoluteUrl(raw: string | null | undefined, base: string): string {
  const text = String(raw ?? '');
  if (!text) return '';
  try {
    return new URL(text, base || 'https://invalid.local/').href;
  } catch {
    return text;
  }
}

function srcUrlOf(el: ElementLike, url: string): string {
  const direct = (el as unknown as { src?: unknown }).src;
  if (typeof direct === 'string' && direct) return direct.slice(0, 300);
  return absoluteUrl(el.getAttribute('src'), url).slice(0, 300);
}

function frameIndexOf(el: ElementLike, iframeElements: ReadonlyArray<ElementLike> | null): number | null {
  if (tagOf(el) !== 'IFRAME') return null;
  const list = iframeElements ?? [];
  for (let index = 0; index < list.length; index += 1) {
    if (list[index] === el) return index;
  }
  return null;
}

function domIdOf(el: ElementLike): string | null {
  return el.id ? String(el.id) : null;
}

function formOfElement(el: ElementLike): ElementLike | null {
  try {
    return el.closest?.('form') ?? null;
  } catch {
    return null;
  }
}

/**
 * DOM 事实 → 页面侧原始图（raw graph，供 buildVomGraph 归一）。
 *
 * 只包含“能进入语义树”的元素（脚本/样式/元数据/纯排版标签被跳过）；祖先链通过 parentKey
 * 表达，labels/ARIA/form 关系按关系方向记录（与 JS recordElementGraph 同向）：
 *   label/html-for：标签 → 控件；labelledby/describedby/errormessage：目标 → 元素；
 *   controls/owns：元素 → 目标；form：表单 → 控件。
 */
export function buildPageGraph(source: VomPageGraphSource): VomGraphRawFacts {
  const maxNodes = Math.min(Math.max(Number(source.limits?.nodes) || VOM_PAGE_GRAPH_LIMITS.nodes, 1), 5000);
  const maxEdges = Math.min(Math.max(Number(source.limits?.edges) || VOM_PAGE_GRAPH_LIMITS.edges, 1), 5000);
  const included: Array<{ el: ElementLike; order: number; id: string }> = [];
  const includedElements = new Set<ElementLike>();
  for (const item of source.collected) {
    const tag = tagOf(item.el);
    if (GRAPH_SKIPPED_TAGS.has(tag)) continue;
    const id = source.elementById.get(item.el);
    if (!id) continue;
    included.push({ el: item.el, order: item.order, id });
    includedElements.add(item.el);
  }
  const domIdToElement = new Map<string, ElementLike>();
  for (const item of included) {
    const domId = domIdOf(item.el);
    if (domId && !domIdToElement.has(domId)) domIdToElement.set(domId, item.el);
  }

  const nodes: VomGraphRawNode[] = [];
  const nodeTruncated = included.length > maxNodes;
  for (const item of included.slice(0, maxNodes)) {
    const parent = item.el.parentElement ?? null;
    const parentIncluded = parent != null && includedElements.has(parent);
    const parentKey = parentIncluded ? source.elementById.get(parent) ?? null : null;
    const ref = source.refByNodeId.get(item.id) ?? null;
    nodes.push({
      key: item.id,
      vomId: item.id,
      ref,
      tag: tagOf(item.el).toLowerCase(),
      domId: domIdOf(item.el),
      role: roleOfElement(item.el),
      parentKey: parentKey ?? null,
      frameIndex: frameIndexOf(item.el, source.iframeElements ?? null),
      srcUrl: tagOf(item.el) === 'IFRAME' ? srcUrlOf(item.el, source.url) : null,
    });
  }

  const edges: Array<{ type: string; from: string; to: string }> = [];
  const seen = new Set<string>();
  let edgeTruncated = false;
  const add = (type: string, from: string | null | undefined, to: string | null | undefined): boolean => {
    const left = from == null ? '' : String(from);
    const right = to == null ? '' : String(to);
    if (!left || !right || left === right) return false;
    const key = type + '\u0000' + left + '\u0000' + right;
    if (seen.has(key)) return false;
    if (edges.length >= maxEdges) {
      edgeTruncated = true;
      return false;
    }
    seen.add(key);
    edges.push({ type, from: left, to: right });
    return true;
  };
  const resolveDomId = (domId: unknown): string | null => {
    const value = domId == null ? '' : String(domId);
    if (!value) return null;
    const element = domIdToElement.get(value) ?? null;
    return element ? source.elementById.get(element) ?? null : null;
  };
  const splitIds = (raw: string | null): string[] => (raw ? String(raw).split(/\s+/).filter(Boolean).slice(0, 8) : []);

  for (const item of included.slice(0, maxNodes)) {
    const el = item.el;
    const parent = el.parentElement ?? null;
    if (parent && includedElements.has(parent)) {
      add('child', source.elementById.get(parent) ?? null, item.id);
    }
    // label / html-for：只对 labelable 控件记录（JS 的 el.labels 语义）。
    if (LABELABLE_TAGS.has(tagOf(el))) {
      const controlDomId = domIdOf(el);
      for (const label of source.collected) {
        if (tagOf(label.el) !== 'LABEL') continue;
        if (!includedElements.has(label.el)) continue;
        const labelId = source.elementById.get(label.el) ?? null;
        if (!labelId) continue;
        const explicitFor = label.el.getAttribute('for');
        if (explicitFor && controlDomId && String(explicitFor) === controlDomId) {
          add('html-for', labelId, item.id);
          continue;
        }
        let contains = false;
        try {
          contains = label.el !== el && typeof label.el.contains === 'function' && label.el.contains(el);
        } catch {
          contains = false;
        }
        if (contains) add('label', labelId, item.id);
      }
      const form = formOfElement(el);
      if (form && includedElements.has(form)) add('form', source.elementById.get(form) ?? null, item.id);
    }
    // ARIA 关系（与 JS 关系方向一致）。
    const role = roleOfElement(el);
    for (const targetId of splitIds(el.getAttribute('aria-controls'))) {
      const to = resolveDomId(targetId);
      if (to) add(role === 'tab' ? 'tab-controls' : 'controls', item.id, to);
    }
    for (const targetId of splitIds(el.getAttribute('aria-owns'))) {
      const to = resolveDomId(targetId);
      if (to) add('owns', item.id, to);
    }
    for (const targetId of splitIds(el.getAttribute('aria-labelledby'))) {
      const from = resolveDomId(targetId);
      if (from) add('labelledby', from, item.id);
    }
    for (const targetId of splitIds(el.getAttribute('aria-describedby'))) {
      const from = resolveDomId(targetId);
      if (from) add('describedby', from, item.id);
    }
    for (const targetId of splitIds(el.getAttribute('aria-errormessage'))) {
      const from = resolveDomId(targetId);
      if (from) add('errormessage', from, item.id);
    }
  }
  const parentKeys = new Set<string>();
  for (const node of nodes) if (node.parentKey) parentKeys.add(String(node.parentKey));
  const roots = nodes.map((node) => String(node.key)).filter((key) => !parentKeys.has(key));
  return {
    available: true,
    nodes,
    edges,
    roots,
    truncated: nodeTruncated || edgeTruncated,
  };
}

// ---------------------------------------------------------------------------
// AX 投影（无 CDP）
// ---------------------------------------------------------------------------

/** AX 根上下文节点 id（DOM 投影没有真实 AX 根；补一个 document 上下文节点）。 */
export const VOM_AX_ROOT_ID = 'ax-root';

/** 一个被观察到的 AX 节点（rich axNodes 的投影）。 */
export interface VomAxEntry {
  axId: string;
  element: ElementLike | null;
  role: string;
}

/**
 * 观察到的 AX 节点 → AX 父子投影。
 *
 * 父节点取“最近的、自身也是 AX 节点的祖先”；没有这样的祖先时挂到 `ax-root` 上下文节点
 * （document）。中间没有 AX 节点的容器不展开（TS 没有真实 AX 树，不虚构 generic 节点）。
 */
export function buildAxProjection(entries: ReadonlyArray<VomAxEntry>): VomAxProjectionNode[] {
  const axIdOfElement = new Map<ElementLike, string>();
  for (const entry of entries) if (entry.element) axIdOfElement.set(entry.element, entry.axId);
  const out: VomAxProjectionNode[] = [];
  let needsRoot = false;
  for (const entry of entries) {
    let parentId: string | null = null;
    let current = entry.element?.parentElement ?? null;
    let guard = 0;
    while (current && guard < 128) {
      const axId = axIdOfElement.get(current);
      if (axId) {
        parentId = axId;
        break;
      }
      current = current.parentElement ?? null;
      guard += 1;
    }
    if (!parentId) {
      parentId = VOM_AX_ROOT_ID;
      needsRoot = true;
    }
    out.push({ nodeId: entry.axId, parentId, role: entry.role });
  }
  if (needsRoot) out.unshift({ nodeId: VOM_AX_ROOT_ID, parentId: null, role: 'document' });
  return out;
}
