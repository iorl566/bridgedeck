// src/content/vom-facts.ts —— observe 的 VOM 页面事实投影（DOM → 可序列化 facts JSON）。
//
// 单一实现边界（W7-E 起）：
// - 内容脚本只负责把「页面事实」抽成 JSON：节点语义/几何、祖先链、ARIA 关系、
//   表格结构、affordance 相关属性。这里**不做** affordance/关系/上下文的判定；
// - 判定全部交给 `packages/vom`（affordance.ts / relations.ts / context.ts），
//   与 `extension/src/lib/vom-*.js` 是同一套语义（差分测试对拍）。
//
// facts 是纯 JSON（无 DOM 引用），因此：
// 1) 可以跨 frame / 跨进程（background、daemon）传输；
// 2) 可以被快照成 tests/fixtures/vom-facts/*.json 做 JS↔TS 差分；
// 3) `projectVomFacts` 是纯函数，单测只需给 JSON，不需要浏览器。
//
// 与 JS 页面图的差异（如实标注，不假装等价）：
// - JS page-lib 直接产出元素级 graph（key/ref/parentKey）；TS 这里产出的是
//   packages/vom 的输入投影（entries + graph 的公开 id），因为 TS 内容脚本的节点 id
//   由 rich.ts 统一分配（DOM id 优先，重复时加 #n 后缀）；
// - aria-* 关系在 facts 里保留 DOM id 原值（与浏览器一致），投影时再解析成节点 id；
//   解析不到的端点直接丢弃（packages/vom 对未知端点同样丢弃）。
//
// 不读 DOM 之外的数据：没有 CDP，因此 backendNodeId 是 DOM 顺序号（见 rich.ts 限制）。

import type {
  BuildVomContextInput,
  BuildVomRelationGraphInput,
  FrameGraphSourceInput,
  NodeFacts,
  VomEntryInput,
  VomGraphEdgeFacts,
  VomGraphFacts,
  VomGraphNodeFacts,
} from '../../../../packages/vom/src/index.ts';
import type { ElementLike } from './dom.ts';
import { accessibleNameOf, normalizeText, roleOfElement, styleOf, tagOf, type DomEnvironment } from './dom.ts';

/** facts 结构版本：字段增删时递增（与 packages/vom 各模块版本独立）。 */
export const VOM_FACTS_VERSION = 1;

/** facts 各集合上限：防止超大页面把 runtime 消息撑爆（事实层先截断，再交给 packages/vom）。 */
export interface VomFactsLimits {
  /** 进入 facts 的节点上限。 */
  readonly nodes: number;
  /** 每个节点保留的祖先链长度上限。 */
  readonly ancestors: number;
  /** 页面图边上限（child/ARIA/frame 边共享）。 */
  readonly edges: number;
  /** 跨 frame 子图上限。 */
  readonly frames: number;
  /** 关系图关系数上限（交给 packages/vom 的 limits）。 */
  readonly relations: number;
  /** 关系图组上限。 */
  readonly groups: number;
  /** 上下文链上限。 */
  readonly contexts: number;
  /** aria-labelledby 链推导深度上限。 */
  readonly chainDepth: number;
}

/** 默认上限：与 packages/vom 的 RELATION_LIMITS / CONTEXT_LIMITS 同量级。 */
export const VOM_FACTS_LIMITS: VomFactsLimits = Object.freeze({
  nodes: 900,
  ancestors: 32,
  edges: 1500,
  frames: 16,
  relations: 600,
  groups: 200,
  contexts: 200,
  chainDepth: 3,
});

/** facts 的固定限制说明（随 facts 一起传输，便于上层如实上报）。 */
export const VOM_FACTS_LIMITATIONS: readonly string[] = Object.freeze([
  'facts 来自 DOM/ARIA/computed style（无 CDP）：backendNodeId 是 DOM 顺序号，不是 CDP backendNodeId',
  'aria-* 关系保留 DOM id 原值；投影时解析不到节点 id 的端点会被丢弃',
  '只包含本帧事实：跨 frame 汇总由调用方提供 frames 子图（TS background 尚未聚合）',
]);

/** 归一化矩形（整数化前保持数值；VOM 只要求数值事实）。 */
export interface VomFactsRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 祖先事实：id 是关系图节点 id，domId 是页面 DOM id（可能为 null）。 */
export interface VomFactsAncestor {
  id: string;
  domId: string | null;
  ref: string | null;
  role: string;
  tag: string;
  name: string | null;
}

/** 显式 ARIA 关系原值（DOM id 列表，未解析）。 */
export interface VomFactsRelations {
  controls: string[];
  labelledBy: string[];
  describedBy: string[];
  owns: string[];
  labelIds: string[];
  form: string[];
  errorMessage: string[];
}

/** 表格结构事实（仅 table/grid/treegrid 锚点节点有）。 */
export interface VomFactsTable {
  headers: Array<{ id: string | null; role: string; name: string }>;
  dataRows: number;
  caption: string | null;
}

/** 单个节点的页面事实（纯 JSON）。 */
export interface VomFactsNode {
  id: string;
  ref: string | null;
  domId: string | null;
  tag: string;
  role: string;
  name: string;
  bounds: VomFactsRect;
  visible: boolean;
  interactive: boolean;
  clickable: boolean;
  inForm: boolean;
  disabled: boolean;
  invalid: boolean;
  inputState: 'empty' | 'filled' | null;
  paintOrder: number;
  backendNodeId: number;
  ancestorIds: string[];
  ancestors: VomFactsAncestor[];
  relations: VomFactsRelations;
  table: VomFactsTable | null;
  // ---- affordance 输入事实（packages/vom.affordance.NodeFacts 的页面投影）----
  inputType: string | null;
  contentEditable: boolean;
  draggable: boolean;
  dragHint: string | null;
  overflowY: string | null;
  scrollable: boolean;
  ariaHasPopup: string | null;
  hoverable: boolean;
  href: string | null;
  cursor: string | null;
  tabIndex: number | null;
  ariaPressed: boolean | null;
  expanded: boolean | null;
  alt: string | null;
  title: string | null;
}

/** frame 事实：graph 是该帧自己的子图（缺省时只放 frame 节点，跨 frame 关系不完整）。 */
export interface VomFactsFrame {
  frameId: number;
  url: string | null;
  parentFrameId: number | null;
  ownerNodeId: string | null;
  graph: VomGraphFacts | null;
}

/** observe 的 VOM 页面事实文档（纯 JSON，可进夹具/跨进程）。 */
export interface VomPageFacts {
  version: 1;
  url: string;
  title: string;
  frameId: number;
  nodes: VomFactsNode[];
  frames: VomFactsFrame[];
  limits: VomFactsLimits;
  truncated: boolean;
  limitations: string[];
}

/** rich.ts 的节点事实在 facts 层需要的字段子集（结构兼容 RichNode，不需要 import rich.ts）。 */
export interface VomSourceNode {
  readonly id: string;
  readonly ref?: string | null;
  readonly role?: string | null;
  readonly tag?: string | null;
  readonly name?: string | null;
  readonly domId?: string | null;
  readonly rect?: { readonly x?: number; readonly y?: number; readonly w?: number; readonly h?: number } | null;
  readonly visible?: boolean;
  readonly clickable?: boolean;
  readonly interactive?: boolean;
  readonly disabled?: boolean;
  readonly inForm?: boolean;
  readonly inputState?: 'empty' | 'filled' | null;
  readonly paintOrder?: number;
  readonly backendNodeId?: number;
  readonly ancestors?: readonly string[] | null;
  readonly table?: { readonly row: number; readonly col: number } | null;
  readonly dragHint?: string | null;
  readonly domValue?: string;
  readonly domChecked?: boolean;
}

/** buildVomPageFacts 的输入：rich 节点 + 已收集元素 + 可选的 frame 子图。 */
export interface VomPageFactsSource {
  readonly url: string;
  readonly title: string;
  readonly frameId?: number;
  /** 页面环境（读 computed style 判断 overflow/scrollable）；缺省时只读属性事实。 */
  readonly env?: DomEnvironment;
  readonly nodes: readonly VomSourceNode[];
  /** 页面里被收集的元素（用于 label[for]/form/表格结构/属性读取）；可为空。 */
  readonly elements?: readonly ElementLike[];
  /** 元素 → rich 节点 id（rich.ts 的 elementById）；缺省时按 DOM id 反查。 */
  readonly elementById?: ReadonlyMap<ElementLike, string>;
  readonly frames?: readonly VomFactsFrame[];
  readonly limits?: Partial<VomFactsLimits>;
}

/** 投影结果：packages/vom 的 relations/context 输入。 */
export interface VomFactsProjection {
  entries: VomEntryInput[];
  graph: VomGraphFacts;
  frames: FrameGraphSourceInput[] | null;
  limits: {
    relations: number;
    groups: number;
    contexts: number;
    chainDepth: number;
  };
}

function lower(value: unknown): string {
  return String(value ?? '').toLowerCase();
}

function finite(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positiveLimit(value: unknown, fallback: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.floor(number), max);
}

function limitSetOf(input: Partial<VomFactsLimits> | null | undefined): VomFactsLimits {
  return {
    nodes: positiveLimit(input && input.nodes, VOM_FACTS_LIMITS.nodes, 5000),
    ancestors: positiveLimit(input && input.ancestors, VOM_FACTS_LIMITS.ancestors, 128),
    edges: positiveLimit(input && input.edges, VOM_FACTS_LIMITS.edges, 5000),
    frames: positiveLimit(input && input.frames, VOM_FACTS_LIMITS.frames, 200),
    relations: positiveLimit(input && input.relations, VOM_FACTS_LIMITS.relations, 5000),
    groups: positiveLimit(input && input.groups, VOM_FACTS_LIMITS.groups, 2000),
    contexts: positiveLimit(input && input.contexts, VOM_FACTS_LIMITS.contexts, 5000),
    chainDepth: positiveLimit(input && input.chainDepth, VOM_FACTS_LIMITS.chainDepth, 6),
  };
}

/** 属性 id 列表：空白分隔、去重、截断（ARIA id 引用语义就是空格分隔的 IDREF 列表）。 */
export function attrIdList(el: ElementLike | null | undefined, name: string): string[] {
  if (!el) return [];
  let raw: string | null = null;
  try {
    raw = el.getAttribute(name);
  } catch {
    return [];
  }
  if (!raw) return [];
  const out: string[] = [];
  for (const token of raw.split(/\s+/)) {
    const value = token.trim();
    if (!value || out.includes(value)) continue;
    out.push(value);
    if (out.length >= 16) break;
  }
  return out;
}

function booleanAttr(el: ElementLike | null | undefined, name: string): boolean | null {
  if (!el) return null;
  try {
    const raw = el.getAttribute(name);
    if (raw === null) return null;
    if (raw === 'true' || raw === '') return true;
    if (raw === 'false') return false;
    return null;
  } catch {
    return null;
  }
}

function intAttr(el: ElementLike | null | undefined, name: string): number | null {
  if (!el) return null;
  try {
    const raw = el.getAttribute(name);
    if (raw === null || raw.trim() === '') return null;
    const value = Number(raw);
    return Number.isInteger(value) ? value : null;
  } catch {
    return null;
  }
}

function stringAttr(el: ElementLike | null | undefined, name: string): string | null {
  if (!el) return null;
  try {
    const raw = el.getAttribute(name);
    return raw === null ? null : raw;
  } catch {
    return null;
  }
}

function emptyRelations(): VomFactsRelations {
  return { controls: [], labelledBy: [], describedBy: [], owns: [], labelIds: [], form: [], errorMessage: [] };
}

function hasAnyRelation(relations: VomFactsRelations): boolean {
  return relations.controls.length > 0 || relations.labelledBy.length > 0
    || relations.describedBy.length > 0 || relations.owns.length > 0
    || relations.labelIds.length > 0 || relations.form.length > 0
    || relations.errorMessage.length > 0;
}

function nonEmpty<T>(list: T[]): T[] | undefined {
  return list.length ? list : undefined;
}

/** facts 可能来自旧快照/手写夹具：关系字段缺失/类型不对时归零，不抛异常。 */
function relationsOfFacts(node: VomFactsNode): VomFactsRelations {
  const raw = (node && node.relations) as Partial<VomFactsRelations> | undefined;
  const list = (value: unknown): string[] => (Array.isArray(value)
    ? value.map((item) => String(item)).filter((item) => item.length > 0).slice(0, 16)
    : []);
  return {
    controls: list(raw && raw.controls),
    labelledBy: list(raw && raw.labelledBy),
    describedBy: list(raw && raw.describedBy),
    owns: list(raw && raw.owns),
    labelIds: list(raw && raw.labelIds),
    form: list(raw && raw.form),
    errorMessage: list(raw && raw.errorMessage),
  };
}

function ancestorIdsOf(node: VomFactsNode): string[] {
  return Array.isArray(node && node.ancestorIds) ? node.ancestorIds.map((id) => String(id)).filter(Boolean) : [];
}

/**
 * 元素 → rich 节点 id 索引。
 *
 * rich.ts 已有一份 elementById；单测/夹具可以只给 elements（按 DOM id 反查），
 * 两边都缺时退化为空映射（facts 仍然合法，只是没有关系/label/form 事实）。
 */
export interface VomElementIndex {
  /** rich 节点 id → 元素。 */
  byNodeId: Map<string, ElementLike>;
  /** DOM id → 元素。 */
  byDomId: Map<string, ElementLike>;
  /** 元素 → rich 节点 id。 */
  idOfElement: Map<ElementLike, string>;
}

export function indexVomElements(
  nodes: readonly VomSourceNode[],
  elements?: readonly ElementLike[],
  elementById?: ReadonlyMap<ElementLike, string>,
): VomElementIndex {
  const byNodeId = new Map<string, ElementLike>();
  const byDomId = new Map<string, ElementLike>();
  const idOfElement = new Map<ElementLike, string>();
  const nodeIds = new Set(nodes.map((node) => node.id));
  const domIdToNodeId = new Map<string, string>();
  for (const node of nodes) {
    if (node.domId) {
      const domId = String(node.domId);
      if (!domIdToNodeId.has(domId)) domIdToNodeId.set(domId, node.id);
    }
  }
  if (elementById) {
    for (const [element, id] of elementById) {
      if (!nodeIds.has(id)) continue;
      idOfElement.set(element, id);
      if (!byNodeId.has(id)) byNodeId.set(id, element);
      if (element.id && !byDomId.has(String(element.id))) byDomId.set(String(element.id), element);
    }
  }
  for (const element of elements ?? []) {
    if (element.id && !byDomId.has(String(element.id))) byDomId.set(String(element.id), element);
    if (idOfElement.has(element)) continue;
    const id = element.id ? domIdToNodeId.get(String(element.id)) : undefined;
    if (!id) continue;
    idOfElement.set(element, id);
    if (!byNodeId.has(id)) byNodeId.set(id, element);
  }
  return { byNodeId, byDomId, idOfElement };
}

/** 元素祖先链 → 节点事实（近 → 远；只记录能解析到 rich 节点的祖先）。 */
export function ancestorsOfElement(
  element: ElementLike | null | undefined,
  index: VomElementIndex,
  nodeById: ReadonlyMap<string, VomFactsNodeSourceMeta>,
  limit: number,
): VomFactsAncestor[] {
  const out: VomFactsAncestor[] = [];
  if (!element) return out;
  let current = element.parentElement ?? null;
  let guard = 0;
  while (current && out.length < limit && guard < 128) {
    const id = index.idOfElement.get(current) ?? (current.id ? domIdToNodeIdOf(index, String(current.id)) : undefined);
    if (id) {
      const meta = nodeById.get(id) ?? null;
      out.push({
        id,
        domId: current.id ? String(current.id) : null,
        ref: meta ? meta.ref : null,
        role: meta ? meta.role : lower(roleOfElement(current)),
        tag: meta ? meta.tag : lower(tagOf(current)),
        name: meta && meta.name ? meta.name : (safeNameOf(current) || null),
      });
    }
    current = current.parentElement ?? null;
    guard += 1;
  }
  return out;
}

interface VomFactsNodeSourceMeta {
  readonly id: string;
  readonly ref: string | null;
  readonly role: string;
  readonly tag: string;
  readonly name: string;
}

function domIdToNodeIdOf(index: VomElementIndex, domId: string): string | undefined {
  const element = index.byDomId.get(domId);
  return element ? index.idOfElement.get(element) : undefined;
}

function safeNameOf(element: ElementLike): string {
  try {
    return accessibleNameOf(element);
  } catch {
    return '';
  }
}

/** 表格结构事实：表头（columnheader/th）+ 数据行数 + 题注；只读取，不改 DOM。 */
export function tableFactsOfElement(element: ElementLike | null | undefined, role: string): VomFactsTable | null {
  if (!element) return null;
  const normalized = lower(role);
  if (normalized !== 'table' && normalized !== 'grid' && normalized !== 'treegrid') return null;
  const queryAll = (selector: string): ElementLike[] => {
    try {
      const list = element.querySelectorAll?.(selector);
      return list ? Array.from(list) : [];
    } catch {
      return [];
    }
  };
  let headerElements = queryAll('[role="columnheader"],[role="rowheader"]');
  if (!headerElements.length) headerElements = queryAll('thead th');
  if (!headerElements.length) {
    const firstRow = queryAll('tr')[0];
    if (firstRow) headerElements = firstRow.querySelectorAll ? Array.from(firstRow.querySelectorAll('th')) : [];
  }
  const headers = headerElements.slice(0, 24).map((header) => ({
    id: header.id ? String(header.id) : null,
    role: lower(roleOfElement(header)) || 'columnheader',
    name: normalizeText(safeNameOf(header)).slice(0, 80),
  })).filter((header) => header.name.length > 0);
  let dataRows = 0;
  try {
    dataRows = tagOf(element) === 'TABLE'
      ? queryAll('tbody tr').length
      : queryAll('[role="row"]').length;
  } catch {
    dataRows = 0;
  }
  const captionElement = element.querySelector?.('caption') ?? null;
  const caption = normalizeText(captionElement?.textContent)
    || normalizeText(stringAttr(element, 'aria-label'))
    || normalizeText(stringAttr(element, 'title'));
  return {
    headers,
    dataRows: Math.min(dataRows, 10_000),
    caption: caption ? caption.slice(0, 120) : null,
  };
}

/** affordance 事实：把 DOM/ARIA 投影成 packages/vom NodeFacts 需要的字段。 */
export interface VomAffordanceFacts {
  inputType: string | null;
  contentEditable: boolean;
  draggable: boolean;
  dragHint: string | null;
  overflowY: string | null;
  scrollable: boolean;
  ariaHasPopup: string | null;
  hoverable: boolean;
  href: string | null;
  cursor: string | null;
  tabIndex: number | null;
  ariaPressed: boolean | null;
  expanded: boolean | null;
}

export function affordanceFactsOfElement(
  env: DomEnvironment | null | undefined,
  element: ElementLike | null | undefined,
  source: VomSourceNode,
): VomAffordanceFacts {
  const inputType = (() => {
    if (!element) return null;
    const direct = (element as { type?: string }).type;
    const value = String(direct ?? stringAttr(element, 'type') ?? '').toLowerCase();
    return value || null;
  })();
  const contentEditable = (() => {
    if (!element) return false;
    try {
      const raw = element.getAttribute('contenteditable');
      return raw !== null && raw !== 'false';
    } catch {
      return false;
    }
  })();
  const style = env && element ? (styleOf(env, element) as { overflowY?: string; overflow?: string; cursor?: string }) : null;
  const overflowY = style ? String(style.overflowY ?? style.overflow ?? '') || null : null;
  const rectHeight = finite(source.rect?.h, 0);
  const scrollHeight = element ? finite((element as { scrollHeight?: number }).scrollHeight, 0) : 0;
  const overflowScrolls = overflowY !== null && /^(auto|scroll|overlay)$/i.test(overflowY);
  const scrollable = overflowScrolls && scrollHeight > rectHeight + 1;
  return {
    inputType,
    contentEditable,
    draggable: booleanAttr(element, 'draggable') === true,
    dragHint: null,
    overflowY,
    scrollable,
    ariaHasPopup: stringAttr(element, 'aria-haspopup'),
    hoverable: booleanAttr(element, 'data-hoverable') === true,
    href: stringAttr(element, 'href'),
    cursor: style && style.cursor ? String(style.cursor) : null,
    tabIndex: intAttr(element, 'tabindex'),
    ariaPressed: booleanAttr(element, 'aria-pressed'),
    expanded: booleanAttr(element, 'aria-expanded'),
  };
}

/** 节点事实 → packages/vom NodeFacts（affordance 判定输入；纯函数，可单测）。 */
export function affordanceInputOf(node: VomFactsNode): NodeFacts {
  const ancestors = Array.isArray(node.ancestors) ? node.ancestors : [];
  return {
    role: node.role || undefined,
    tag: node.tag || undefined,
    name: node.name || undefined,
    inputType: node.inputType || undefined,
    contentEditable: node.contentEditable,
    draggable: node.draggable,
    dragHint: node.dragHint || undefined,
    overflowY: node.overflowY || undefined,
    scrollable: node.scrollable,
    ariaHasPopup: node.ariaHasPopup || undefined,
    hoverable: node.hoverable,
    href: node.href || undefined,
    clickable: node.clickable,
    cursor: node.cursor || undefined,
    tabIndex: node.tabIndex ?? undefined,
    ariaPressed: node.ariaPressed ?? undefined,
    expanded: node.expanded ?? undefined,
    ancestors: ancestors.map((ancestor) => ({ role: ancestor.role, tag: ancestor.tag })),
  };
}

/** 元素 → 表格/关系之外的表格坐标不需要：VOM 上下文只需要表格结构事实。 */

/**
 * 抽取页面事实。
 *
 * 输入是 rich.ts 已经筛过的语义节点（role/ref/几何/可见性已定），这里只补
 * 「rich 层没保留的属性事实」：ARIA 关系 id、label/form 归属、表格结构、affordance 输入。
 */
export function buildVomPageFacts(source: VomPageFactsSource): VomPageFacts {
  const limits = limitSetOf(source.limits);
  const sourceNodes = source.nodes.slice(0, limits.nodes);
  const nodeTruncated = source.nodes.length > limits.nodes;
  const index = indexVomElements(sourceNodes, source.elements, source.elementById);
  const nodeById = new Map<string, VomFactsNodeSourceMeta>();
  for (const node of sourceNodes) {
    nodeById.set(node.id, {
      id: node.id,
      ref: node.ref ?? null,
      role: lower(node.role),
      tag: lower(node.tag),
      name: normalizeText(node.name),
    });
  }
  const labels = (source.elements ?? []).filter((element) => tagOf(element) === 'LABEL');
  const nodes: VomFactsNode[] = [];
  for (let order = 0; order < sourceNodes.length; order += 1) {
    const node = sourceNodes[order];
    if (!node) continue;
    const element = index.byNodeId.get(node.id) ?? null;
    const domId = node.domId ? String(node.domId) : (element && element.id ? String(element.id) : null);
    const role = lower(node.role || (element ? roleOfElement(element) : ''));
    const tag = lower(node.tag || (element ? tagOf(element) : ''));
    const ancestors = element
      ? ancestorsOfElement(element, index, nodeById, limits.ancestors)
      : (node.ancestors ?? []).slice(0, limits.ancestors).map((id) => {
        const meta = nodeById.get(id);
        return {
          id: String(id),
          domId: null,
          ref: meta ? meta.ref : null,
          role: meta ? meta.role : '',
          tag: meta ? meta.tag : '',
          name: meta && meta.name ? meta.name : null,
        } satisfies VomFactsAncestor;
      });
    const relations = emptyRelations();
    if (element) {
      relations.controls = attrIdList(element, 'aria-controls');
      relations.labelledBy = attrIdList(element, 'aria-labelledby');
      relations.describedBy = attrIdList(element, 'aria-describedby');
      relations.owns = attrIdList(element, 'aria-owns');
      relations.errorMessage = attrIdList(element, 'aria-errormessage');
      if (domId) {
        for (const label of labels) {
          if (attrIdList(label, 'for').includes(domId) || containsElement(label, element)) {
            if (label.id) relations.labelIds.push(String(label.id));
          }
        }
        relations.labelIds = [...new Set(relations.labelIds)];
      }
      const formElement = (() => {
        try {
          return element.closest?.('form') ?? null;
        } catch {
          return null;
        }
      })();
      if (formElement && formElement.id && String(formElement.id) !== domId) relations.form.push(String(formElement.id));
    }
    const invalid = booleanAttr(element, 'aria-invalid') === true;
    const affordance = affordanceFactsOfElement(source.env, element, node);
    const table = tableFactsOfElement(element, role);
    const paintOrder = Number.isInteger(node.paintOrder) ? Number(node.paintOrder) : order;
    const backendNodeId = Number.isInteger(node.backendNodeId) ? Number(node.backendNodeId) : order + 1;
    const dragHint = node.dragHint ?? null;
    nodes.push({
      id: String(node.id),
      ref: node.ref ?? null,
      domId,
      tag,
      role,
      name: normalizeText(node.name || (element ? safeNameOf(element) : '')),
      bounds: {
        x: finite(node.rect?.x, 0),
        y: finite(node.rect?.y, 0),
        width: finite(node.rect?.w, 0),
        height: finite(node.rect?.h, 0),
      },
      visible: node.visible !== false,
      interactive: node.interactive === true || node.clickable === true,
      clickable: node.clickable === true,
      inForm: node.inForm === true || (element ? Boolean(element.closest?.('form') ?? (element as { form?: unknown }).form) : false),
      disabled: node.disabled === true,
      invalid,
      inputState: node.inputState ?? null,
      paintOrder,
      backendNodeId,
      ancestorIds: ancestors.map((ancestor) => ancestor.id),
      ancestors,
      relations,
      table,
      ...affordance,
      dragHint,
      alt: stringAttr(element, 'alt'),
      title: stringAttr(element, 'title'),
    });
  }
  const frames = (source.frames ?? []).slice(0, limits.frames);
  return {
    version: VOM_FACTS_VERSION,
    url: String(source.url ?? ''),
    title: String(source.title ?? ''),
    frameId: Number.isInteger(source.frameId) ? Number(source.frameId) : 0,
    nodes,
    frames: frames.map((frame) => ({
      frameId: Number(frame.frameId),
      url: frame.url ?? null,
      parentFrameId: Number.isInteger(frame.parentFrameId) ? Number(frame.parentFrameId) : null,
      ownerNodeId: frame.ownerNodeId ?? null,
      graph: frame.graph ?? null,
    })),
    limits,
    truncated: nodeTruncated || frames.length < (source.frames ?? []).length,
    limitations: [...VOM_FACTS_LIMITATIONS],
  };
}

function containsElement(container: ElementLike, element: ElementLike): boolean {
  try {
    if (typeof container.contains === 'function') return container.contains(element);
  } catch {
    // contains 不可用时按父子链判断
  }
  let current = element.parentElement ?? null;
  let guard = 0;
  while (current && guard < 128) {
    if (current === container) return true;
    current = current.parentElement ?? null;
    guard += 1;
  }
  return false;
}

/** 关系边类型（packages/vom GraphEdgeType 的页面侧子集）。 */
export type VomFactsEdgeType =
  | 'child'
  | 'controls'
  | 'tab-controls'
  | 'labelledby'
  | 'describedby'
  | 'owns'
  | 'form'
  | 'label'
  | 'html-for'
  | 'errormessage'
  | 'frame';

export interface VomFactsEdge {
  type: VomFactsEdgeType;
  from: string;
  to: string;
}

/** 边收集器：去重 + 上限 + truncated 标记。 */
export class VomEdgeCollector {
  readonly edges: VomFactsEdge[] = [];
  private readonly seen = new Set<string>();
  private readonly max: number;
  private truncated = false;

  constructor(max: number) {
    this.max = max;
  }

  add(type: VomFactsEdgeType, from: unknown, to: unknown): boolean {
    const left = from == null ? '' : String(from);
    const right = to == null ? '' : String(to);
    if (!left || !right || left === right) return false;
    const key = type + '\u0000' + left + '\u0000' + right;
    if (this.seen.has(key)) return false;
    if (this.edges.length >= this.max) {
      this.truncated = true;
      return false;
    }
    this.seen.add(key);
    this.edges.push({ type, from: left, to: right });
    return true;
  }

  get isTruncated(): boolean {
    return this.truncated;
  }
}

/**
 * facts → packages/vom 输入（entries + 页面图 + frame 子图 + limits）。
 *
 * 纯函数：不读 DOM，只做 id 解析/边构造。aria-* 的 DOM id 在这里解析成节点 id，
 * 解析不到的端点丢弃（关系层对未知端点同样会丢）。
 */
export function projectVomFacts(facts: VomPageFacts): VomFactsProjection {
  const nodes = Array.isArray(facts.nodes) ? facts.nodes : [];
  const nodeById = new Map<string, VomFactsNode>();
  const domIdToNodeId = new Map<string, string>();
  for (const node of nodes) {
    if (!node || !node.id) continue;
    nodeById.set(String(node.id), node);
    if (node.domId) {
      const domId = String(node.domId);
      if (!domIdToNodeId.has(domId)) domIdToNodeId.set(domId, String(node.id));
    }
  }
  const limits = limitSetOf(facts.limits);
  const collector = new VomEdgeCollector(limits.edges);
  const resolve = (domId: unknown): string | null => {
    const value = domId == null ? '' : String(domId);
    return value ? domIdToNodeId.get(value) ?? null : null;
  };
  const graphNodes: VomGraphNodeFacts[] = [];
  for (const node of nodes) {
    if (!node || !node.id) continue;
    const ancestorIds = ancestorIdsOf(node);
    graphNodes.push({
      id: String(node.id),
      domId: node.domId ?? null,
      role: node.role,
      tag: node.tag,
      name: node.name,
      parentId: ancestorIds.length ? String(ancestorIds[0]) : null,
    });
  }
  // frame 节点：关系/上下文里 frame:<id> 也是节点；owner 节点存在时才建 frame 边。
  for (const frame of facts.frames ?? []) {
    const frameId = Number(frame.frameId);
    if (!Number.isInteger(frameId)) continue;
    const frameNodeId = 'frame:' + String(frameId);
    if (!graphNodes.some((node) => node.id === frameNodeId)) {
      graphNodes.push({ id: frameNodeId, domId: null, role: frameId === 0 ? 'document' : 'frame', tag: 'iframe', name: frame.url ?? '', parentId: frame.ownerNodeId ?? null });
    }
    if (frame.ownerNodeId) collector.add('frame', frame.ownerNodeId, frameNodeId);
  }
  for (const node of nodes) {
    if (!node || !node.id) continue;
    const id = String(node.id);
    const ancestorIds = ancestorIdsOf(node);
    const relations = relationsOfFacts(node);
    // 1) DOM 包含：最近祖先 → 节点。
    const parentId = ancestorIds.length ? String(ancestorIds[0]) : '';
    if (parentId && nodeById.has(parentId)) collector.add('child', parentId, id);
    // 2) 显式 ARIA 关系：值在 facts 里是 DOM id，解析成节点 id。
    for (const target of relations.controls) {
      const to = resolve(target);
      if (!to) continue;
      collector.add('controls', id, to);
      if (node.role === 'tab') collector.add('tab-controls', id, to);
    }
    for (const target of relations.labelledBy) {
      const from = resolve(target);
      if (from) collector.add('labelledby', from, id);
    }
    for (const target of relations.describedBy) {
      const from = resolve(target);
      if (from) collector.add('describedby', from, id);
    }
    for (const target of relations.owns) {
      const to = resolve(target);
      if (to) collector.add('owns', id, to);
    }
    for (const target of relations.errorMessage) {
      const from = resolve(target);
      if (from) collector.add('errormessage', from, id);
    }
    for (const target of relations.labelIds) {
      const from = resolve(target);
      if (from) collector.add('html-for', from, id);
    }
    for (const target of relations.form) {
      const from = resolve(target);
      if (from) collector.add('form', from, id);
    }
    // 3) form 归属：祖先里最近的 form 锚点（即使 form 没有 DOM id 也能落边）。
    const ancestors = Array.isArray(node.ancestors) ? node.ancestors : [];
    const formAncestor = ancestors.find((ancestor) => ancestor.tag === 'form' || ancestor.role === 'form');
    if (formAncestor && formAncestor.id !== id) collector.add('form', formAncestor.id, id);
  }
  // 4) 隐式 label 包裹：facts 层只记录了有 DOM id 的 label；没有 id 的 label 由 graph 的
  //    child 边 + rich 节点关系兜底（不在这里虚构）。
  const entries: VomEntryInput[] = nodes.map((node) => {
    const relations = relationsOfFacts(node);
    const ancestorIds = ancestorIdsOf(node);
    const ancestors = Array.isArray(node.ancestors) ? node.ancestors : [];
    const relationFacts = hasAnyRelation(relations)
      ? {
        ...(nonEmpty(relations.controls) ? { controls: relations.controls.slice() } : {}),
        ...(nonEmpty(relations.labelledBy) ? { labelledBy: relations.labelledBy.slice() } : {}),
        ...(nonEmpty(relations.describedBy) ? { describedBy: relations.describedBy.slice() } : {}),
        ...(nonEmpty(relations.owns) ? { owns: relations.owns.slice() } : {}),
        ...(nonEmpty(relations.labelIds) ? { labelIds: relations.labelIds.slice() } : {}),
        ...(nonEmpty(relations.form) ? { form: relations.form.slice() } : {}),
        ...(nonEmpty(relations.errorMessage) ? { errorMessage: relations.errorMessage.slice() } : {}),
      }
      : null;
    return {
      id: String(node.id),
      node: {
        ...(node.domId ? { id: node.domId } : {}),
        ...(node.role ? { role: node.role } : {}),
        ...(node.tag ? { tag: node.tag } : {}),
        ...(node.name ? { name: node.name } : {}),
        ...(node.alt ? { alt: node.alt } : {}),
        ...(node.title ? { title: node.title } : {}),
        ...(node.invalid ? { invalid: true } : {}),
        ancestors: ancestors.map((ancestor) => ({
          id: ancestor.domId,
          ref: ancestor.id,
          role: ancestor.role || undefined,
          tag: ancestor.tag || undefined,
          name: ancestor.name ?? undefined,
        })),
        ...(node.table
          ? {
            tableFacts: {
              headers: (Array.isArray(node.table.headers) ? node.table.headers : []).map((header) => ({ id: header.id, role: header.role, name: header.name })),
              dataRows: node.table.dataRows,
              caption: node.table.caption,
            },
          }
          : {}),
      },
      ...(relationFacts ? { relations: relationFacts } : {}),
      ...(ancestorIds.length ? { ancestorIds: ancestorIds.slice(0, 8) } : {}),
    } satisfies VomEntryInput;
  });
  const roots = graphNodes.filter((node) => !node.parentId).map((node) => String(node.id));
  const graph: VomGraphFacts = {
    available: true,
    nodes: graphNodes,
    edges: collector.edges.map((edge) => ({ type: edge.type, from: edge.from, to: edge.to } satisfies VomGraphEdgeFacts)),
    roots,
    truncated: collector.isTruncated,
  };
  const frames: FrameGraphSourceInput[] | null = (facts.frames ?? []).length
    ? (facts.frames ?? []).map((frame) => {
      const frameId = Number(frame.frameId);
      const frameNodeId = 'frame:' + String(frameId);
      const minimalGraph: VomGraphFacts = {
        available: true,
        nodes: [{ id: frameNodeId, role: frameId === 0 ? 'document' : 'frame', url: frame.url ?? undefined, parentId: frame.ownerNodeId ?? null }],
        edges: frame.ownerNodeId ? [{ type: 'frame', from: frame.ownerNodeId, to: frameNodeId }] : [],
        roots: [],
        truncated: false,
      };
      return {
        frameId,
        url: frame.url ?? undefined,
        parentFrameId: frame.parentFrameId ?? undefined,
        ...(frame.graph ? { graph: frame.graph } : { graph: minimalGraph }),
      } satisfies FrameGraphSourceInput;
    })
    : null;
  return {
    entries,
    graph,
    frames,
    limits: {
      relations: limits.relations,
      groups: limits.groups,
      contexts: limits.contexts,
      chainDepth: limits.chainDepth,
    },
  };
}

/** projectVomFacts → buildVomRelationGraph 输入（单点组装，避免调用方猜字段）。 */
export function relationInputOf(projection: VomFactsProjection): BuildVomRelationGraphInput {
  return {
    entries: projection.entries,
    graph: projection.graph,
    ...(projection.frames ? { frames: projection.frames } : {}),
    limits: {
      relations: projection.limits.relations,
      groups: projection.limits.groups,
      contexts: projection.limits.contexts,
      chainDepth: projection.limits.chainDepth,
    },
  };
}

/** projectVomFacts → buildVomContext 输入。 */
export function contextInputOf(
  projection: VomFactsProjection,
  frames?: BuildVomContextInput['frames'],
): BuildVomContextInput {
  return {
    entries: projection.entries,
    graph: projection.graph,
    ...(frames ? { frames } : {}),
    limits: {
      groups: projection.limits.groups,
      contexts: projection.limits.contexts,
      depth: projection.limits.chainDepth,
    },
  };
}

/** 浅拷贝 facts（测试/诊断用；不改变结构）。 */
export function cloneVomFacts(facts: VomPageFacts): VomPageFacts {
  return JSON.parse(JSON.stringify(facts)) as VomPageFacts;
}
