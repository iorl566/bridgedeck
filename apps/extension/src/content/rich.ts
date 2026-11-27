// src/content/rich.ts —— observe 高级面（M-C 第四批）：VOM 摘要、AX 摘要子集、DOM 事实、分层与表格。
//
// 设计边界（如实标注，不伪装成 CDP）：
// - 全部数据来自页面 DOM / ARIA / computed style，**不使用 chrome.debugger**；
// - `backendNodeId` 是「DOM 顺序号」派生出来的稳定整数 id（不是 CDP backendNodeId），
//   字段名沿用 CLI/daemon 契约，并在 `backendNodeSource: 'dom-order'` 与 vom.limitations 里写明；
// - VOM 摘要（W7-E 起）：affordance / relations / context / groups 全部由 `packages/vom`
//   计算（单一实现，不再在 apps 侧自造）；rich.ts 只负责 DOM 事实抽取（vom-facts.ts）与
//   结果展开。六阶段评分/计费账本/预算裁剪仍不在本层（vomScore 仍是启发式）。
// - AX 是**摘要子集**：role/name/bounds/可见性/表格坐标，来自 DOM ARIA 投影；没有真实
//   Accessibility.getFullAXTree 的 ignored/invalid 语义，如实写在 limitations。
//
// 返回结构由 background 的 `observe` 归一后原样上抛（字段名与 CLI/E2E 契约一致）。

import type {
  AffordanceResult,
  AffordanceSummary,
  VomContextModel,
  VomGraphObservedNode,
  VomGraphPayload,
  VomRelationGraph,
} from '../../../../packages/vom/src/index.ts';
import {
  AX_GRAPH_LIMITS,
  VOM_GRAPH_DEFAULT_LIMITS,
  buildVomGraph,
  mergeAxIntoGraph,
} from '../../../../packages/vom/src/index.ts';
import {
  accessibleNameOf,
  isActionableRole,
  isVisible,
  normalizeText,
  rectOf,
  roleOfElement,
  semanticMarkersOf,
  styleOf,
  tagOf,
  type DomEnvironment,
  type ElementLike,
} from './dom.ts';
import type { BuiltObservation } from './dom.ts';
import { VOM_FACTS_LIMITS, buildVomPageFacts } from './vom-facts.ts';
import type { VomPageFacts } from './vom-facts.ts';
import {
  buildVomSummary,
  renderVomSummaryText,
  verifyVomSummary,
  type VomGroupsSummary,
  type VomUnifiedSummary,
} from './vom-summary.ts';
import {
  VOM_DEEP_LIMITATIONS,
  applyDeepNodeFacts,
  createVomCaptureIssues,
  type VomCaptureIssue,
  type VomDeepNodeLike,
} from './vom-deep.ts';
import { buildLayerFacts, type VomLayerBand } from './vom-layers.ts';
import { collectVisualObjects, type VomVisualObject } from './vom-visual.ts';
import { buildAxProjection, buildPageGraph, type VomAxEntry } from './vom-page-graph.ts';
import {
  applyVomWeights,
  contextStatsOf,
  vomWeightOptionsOf,
  type VomScoreFactor,
  type VomWeightsPayload,
  type VomWeightOptions,
} from './vom-weights.ts';
import {
  refIdentityKeyOf,
  refIdentityOf,
  refStableRefOf,
} from '../refs/registry.ts';
import type {
  ContentClosedShadowCandidate,
  ContentClosedShadowEntry,
  ContentUnmappedAxCandidate,
  ContentUnmappedAxEntry,
} from './protocol.ts';

/** observe 上与本文件相关的开关（CLI/daemon 用 camelCase 传入）。 */
export interface RichOptions {
  vom?: boolean;
  vomDeep?: boolean;
  ax?: boolean;
  facts?: boolean;
  fallbackAx?: boolean;
  compareAx?: boolean;
  pipeline?: string;
  debugSurfaces?: boolean;
  closedShadow?: boolean;
  /** --vom 的权重/计费/预算开关（vom-weights.ts 解析后的结构，或缺省时直接给原始 params 由本层解析）。 */
  weights?: VomWeightOptions;
  /**
   * VOM 深水区事实（命中测试/对比度/视觉对象/分层/页面图）开关，默认 true。
   * false 仅用于夹具生成（tests/support/write-vom-fixtures.ts）：facts.json 必须与
   * 运行时“深水区回填前”的页面事实一致，否则差分基线会被深水区副作用污染。
   */
  deepFacts?: boolean;
}

export interface RichRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RichBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  left: number;
  top: number;
}

export interface RichTableCoord {
  row: number;
  col: number;
}

export interface RichNode {
  id: string;
  ref: string | null;
  role: string;
  name: string;
  tag: string;
  domId: string | null;
  rect: RichRect;
  bounds: RichBounds;
  visible: boolean;
  pointerEvents: string;
  clickable: boolean;
  interactive: boolean;
  disabled: boolean;
  inForm: boolean;
  inputState: 'empty' | 'filled' | null;
  dragHint: string | null;
  paintOrder: number;
  domPaintOrder: number;
  vomScore: number;
  backendNodeId: number;
  backendNodeSource: 'dom-order';
  ancestors: string[];
  table: RichTableCoord | null;
  domValue?: string;
  domChecked?: boolean;
  formStateStale?: boolean;
  ax?: { role: string; name: string; backendNodeId: number; nodeId?: string };
  /** 类型化 affordance（packages/vom.affordanceForNode 的判定；observe --vom 时填充）。 */
  affordance?: AffordanceResult;
  /**
   * 跨 revision 稳定的引用（`s-<hash>`）。
   * 与 background refDetails 用同一套 identity/hash（refs/registry.ts），
   * 供 `refs negotiate <stableRef>` 命中注册表（5b）。
   */
  stableRef?: string | null;
  // ---- VOM 深水区事实（observe --vom；vom-deep.ts 回填）----
  /** 命中测试结论（self/descendant/ancestor/blocked/pointer-events-none/offscreen/…）。 */
  hitTest?: string | null;
  /** 被谁挡住（hitTest=blocked 时；{tag,role,id,name}）。 */
  occludedBy?: { tag: string; role: string | null; id: string | null; name: string | null } | null;
  /** 是否与视口相交。 */
  inViewport?: boolean;
  /** 文字对有效背景的 WCAG 对比度（两位小数；解析失败 null）。 */
  contrast?: number | null;
  /** 对比度低于 4.5 的文字节点。 */
  lowContrast?: boolean;
  /** 页面图里的公开 id（= 本节点 id；vom.graph 用）。 */
  graphKey?: string | null;
  /** observed 节点的公开 id 优先项（TS 扩展字段；保证 vom.graph 用 rich 节点 id，与 ancestorIds 对齐）。 */
  vomId?: string | null;
  /** 页面图里的父节点 id。 */
  parentId?: string | null;
  /** 页面图里的祖先 id 链（近 → 远；与 vom.graph 的 parentId 链一致）。 */
  ancestorIds?: string[];
}

export interface RichAxNode {
  id: string;
  role: string;
  name: string;
  tag: string;
  bounds: RichBounds;
  visible: boolean;
  interactive: boolean;
  backendNodeId: number;
  table: RichTableCoord | null;
  ref: string | null;
}

export interface RichTable {
  id: string;
  label: string;
  role: string;
  headers: string[];
  rows: number;
  columns: number;
  frameId: number;
}

export interface RichBlockingLayer {
  id: string;
  name: string;
  role: string;
  coverage: number;
  bounds: RichBounds;
  zIndex: number;
  position: string;
}

export interface RichVomStage {
  stage: 'facts' | 'identity' | 'relations' | 'layout' | 'paint' | 'interact';
  ok: boolean;
  count: number;
  ms: number;
}

export interface RichVomEdge {
  type: string;
  from: string;
  to: string;
  /** child 边的兼容字段（JS 基线 vom.edges 同形；E2E 35h 消费）。 */
  child?: string;
  parent?: string;
}

/**
 * observe 顶层阶段指标（stages）：页面库/深观察的采集与计时证据。
 *
 * 字段口径与 JS 页面库 `finishFunnel` 一致：`lineTokens` 是**总 tokens**（历史字段名），
 * `maxLineTokens` 是单行最大 token 数；`ms.semantics` = walk − visibility − stealth。
 */
export interface RichStagesSummary {
  visited: number;
  hidden: number;
  stealth: number;
  skippedTag: number;
  emitted: number;
  refs: number;
  truncated: boolean;
  iframes: number;
  tokens: number;
  lineTokens: number;
  maxLineTokens: number;
  ms: {
    walk: number;
    visibility: number;
    stealth: number;
    semantics: number;
  };
}

/** buildRichObservation 的观察上下文（documentId/frameId 用于 stableRef 身份对齐）。 */
export interface RichObservationContext {
  documentId?: string;
  frameId?: number;
  cdpSessionId?: string | null;
}

export interface RichVomPayload {
  version: 1;
  source: 'packages/vom';
  stats: {
    members: number;
    edges: number;
    interactive: number;
    relations: number;
    groups: number;
    affordance: number;
  };
  stages: RichVomStage[];
  nodes: RichNode[];
  edges: RichVomEdge[];
  affordance: AffordanceSummary;
  /** 完整关系图（containment/ownership/roots/AX 边；E2E 35h 消费）。 */
  graph: VomGraphPayload;
  /** 图计数（节点/边/按类型；跨帧子图 counts.nodes 同形）。 */
  counts: { nodes: number; edges: number; byType: Record<string, number> };
  /** 视觉对象清单（区域 + 可动作 ref；与顶层 visualObjects 同源）。 */
  visual: VomVisualObject[];
  /** 采集问题（正常页面为空数组；只记录真实失败）。 */
  issues: VomCaptureIssue[];
  /** packages/vom 摘要的不变量自检（空 violations = 通过；不伪造通过）。 */
  selfCheck: { ok: boolean; violations: string[] };
  limitations: string[];
}

export interface RichDeepVomPayload {
  nodes: RichNode[];
  stages: { collected: number; emitted: number; sorted: 'paint-order'; tokens: number; interactions: number };
  vomFunnel: { collected: number; emitted: number; droppedReasons: Array<{ reason: string; count: number }> };
  limitations: string[];
}

export interface RichResult {
  nodes?: RichNode[];
  axNodes?: RichAxNode[];
  axJoin?: { matched: number; byBackendNodeId: number; byBounds: number; unmatched: number; total: number };
  facts?: {
    nodes: number;
    axMatched: number;
    vomMatched: number;
    source: 'dom-snapshot';
    shadowRoots: number;
    frames: number;
    limitations: string[];
  };
  tables?: RichTable[];
  blockingLayers?: RichBlockingLayer[];
  pipelineCompare?: {
    pageLib: { refs: number; lines: number };
    ax: { nodes: number; lines: number };
    interactiveTotal: number;
    matched: number;
    axCoverage: number;
    limitations: string[];
  };
  pipeline?: string;
  fallback?: 'ax';
  vom?: RichVomPayload;
  /** packages/vom 的 affordance 汇总（observe --vom）。 */
  vomAffordance?: AffordanceSummary;
  /** packages/vom 的关系图 v3（observe --vom；与 JS observe 顶层 `relations` 同名同形）。 */
  relations?: VomRelationGraph;
  /** packages/vom 的语义上下文模型（landmark/form/table；与 JS observe 顶层 `context` 同形）。 */
  context?: VomContextModel;
  /** packages/vom context 的组摘要（landmark/form/table 计数 + 前 N 组）。 */
  groups?: VomGroupsSummary;
  /** 一行诊断文本（结构化字段仍是唯一事实源）。 */
  vomSummaryText?: string;
  /** 顶层阶段指标（页面采集/计时证据；observe --vom 与 --facts 时提供）。 */
  stages?: RichStagesSummary;
  /** 视觉对象（canvas/图片/自绘区域 + 可动作 ref 的 stableRef）。 */
  visualObjects?: VomVisualObject[];
  /** paint-order 分层（L2 带：modal/mask；observe --vom 时提供）。 */
  layers?: VomLayerBand[];
  /** 采集问题（只记录真实失败；正常页面为空数组）。 */
  issues?: VomCaptureIssue[];
  deepVom?: RichDeepVomPayload;
  ariaSnapshot?: string;
  semantic?: { version: 1; stats: { members: number; groups: number } };
  observation?: string;
  debugSurfaces?: string;
  /** --vom 的打分/计费/预算账本（字段与 JS observe.vomWeights 同形；5b 消费）。 */
  vomWeights?: VomWeightsPayload;
  /** --vom-explain 的逐节点因素明细。 */
  vomExplain?: Record<string, VomScoreFactor[]> | null;
  /** closed shadow 只读条目（background 透传候选，内容脚本编号 @eN；20v）。 */
  closedShadow?: ContentClosedShadowEntry[];
  /** 未映射到 @eN 的可交互元素（AX/closed shadow 补充；5f）。 */
  unmappedAx?: ContentUnmappedAxEntry[];
  /** 本帧 CDP session 语义（`tabId:frameId`；background 透传时回显，35b）。 */
  cdpSessionId?: string | null;
}

export const RICH_LIMITATIONS: readonly string[] = Object.freeze([
  'no-debugger: 没有 CDP，DOMSnapshot/Accessibility 域不可得；事实来自 DOM + computed style',
  'backendNodeId 由 DOM 顺序派生（backendNodeSource=dom-order），不是 CDP backendNodeId',
  'VOM 摘要：affordance/relations/context/groups 由 packages/vom 计算（单一实现），不含六阶段评分/计费账本/预算裁剪',
  'AX 是 DOM/ARIA 投影的子集：没有 ignored/reason 等真实无障碍树语义',
]);

const SKIPPED_TAGS: ReadonlySet<string> = new Set([
  'SCRIPT', 'STYLE', 'HEAD', 'META', 'LINK', 'TITLE', 'NOSCRIPT', 'TEMPLATE',
  'BR', 'HR', 'OPTION', 'OPTGROUP', 'THEAD', 'TBODY', 'TFOOT', 'COLGROUP', 'COL',
  'SOURCE', 'TRACK', 'PARAM', 'BASE',
]);

const CONTAINER_TAGS: ReadonlySet<string> = new Set([
  'MAIN', 'FORM', 'SECTION', 'NAV', 'HEADER', 'FOOTER', 'ARTICLE', 'ASIDE', 'DIV',
  'TABLE', 'UL', 'OL', 'DL', 'FIELDSET', 'DETAILS', 'DIALOG',
]);

interface Collected {
  el: ElementLike;
  order: number;
  depth: number;
  shadow: boolean;
}

/** collectElements 的收集项（导出给单测/夹具生成复用同一 id 分配规则）。 */
export type RichCollectedElement = Collected;

/**
 * 元素 → rich 节点 id（DOM id 优先，重复时加 #n 后缀）。
 *
 * 单独导出是为了让夹具生成/差分测试与运行时用**同一条** id 规则：
 * VOM 的关系/上下文端点全靠这张表对齐，两套规则会让差分测试失去意义。
 */
export function assignRichElementIds(collected: readonly Collected[]): Map<ElementLike, string> {
  const elementById = new Map<ElementLike, string>();
  const usedIds = new Set<string>();
  let index = 0;
  for (const item of collected) {
    index += 1;
    const base = item.el.id ? String(item.el.id) : 'n' + String(index);
    let id = base;
    let suffix = 2;
    while (usedIds.has(id)) {
      id = base + '#' + String(suffix);
      suffix += 1;
    }
    usedIds.add(id);
    elementById.set(item.el, id);
  }
  return elementById;
}

function asElement(value: unknown): ElementLike | null {
  return value && typeof value === 'object' && typeof (value as ElementLike).tagName === 'string'
    ? (value as ElementLike)
    : null;
}

function shadowRootOf(el: ElementLike): (ElementLike & { querySelectorAll?(selector: string): ArrayLike<ElementLike> }) | null {
  const root = (el as unknown as { shadowRoot?: unknown }).shadowRoot;
  const host = asElement(root);
  if (host) return host as ElementLike & { querySelectorAll?(selector: string): ArrayLike<ElementLike> };
  return null;
}

/** 收集元素：主文档 `*` + 所有 open shadow root（closed shadow 无法从页面读到，如实缺席）。 */
export function collectElements(env: DomEnvironment): { collected: Collected[]; shadowRoots: number } {
  const doc = env.document;
  const collected: Collected[] = [];
  let shadowRoots = 0;
  let order = 0;
  const pushAll = (roots: ArrayLike<ElementLike>, depth: number, shadow: boolean): void => {
    for (const el of Array.from(roots)) {
      const element = asElement(el);
      if (!element) continue;
      collected.push({ el: element, order, depth, shadow });
      order += 1;
      const root = shadowRootOf(element);
      if (root) {
        shadowRoots += 1;
        try {
          const inner = root.querySelectorAll?.('*');
          if (inner) pushAll(inner, depth + 1, true);
        } catch {
          // 读不到 shadow 内容（closed）时只保留 host，不报错
        }
      }
    }
  };
  try {
    const list = doc.querySelectorAll?.('*');
    if (list) pushAll(list, 0, false);
  } catch {
    // 页面处于卸载过程：返回空集合
  }
  return { collected, shadowRoots };
}

function boundsOf(el: ElementLike): RichBounds {
  const rect = rectOf(el);
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
    left: rect.left,
    top: rect.top,
  };
}

function inFormOf(el: ElementLike): boolean {
  try {
    return Boolean(el.closest?.('form')) || Boolean((el as unknown as { form?: unknown }).form);
  } catch {
    return false;
  }
}

function disabledOf(el: ElementLike): boolean {
  if ((el as { disabled?: boolean }).disabled === true) return true;
  return el.getAttribute('aria-disabled') === 'true';
}

function tableCoordOf(el: ElementLike, collectedIndex: Map<ElementLike, string>): RichTableCoord | null {
  const tag = tagOf(el);
  const role = roleOfElement(el);
  const parent = el.parentElement ?? null;
  if (tag === 'TD' || tag === 'TH') {
    const row = parent && tagOf(parent) === 'TR' ? (parent as unknown as { rowIndex?: number }).rowIndex ?? 0 : 0;
    const cell = (el as unknown as { cellIndex?: number }).cellIndex ?? 0;
    return { row: Number(row), col: Number(cell) };
  }
  if (role === 'gridcell' || role === 'columnheader' || role === 'cell') {
    const rowEl = parent;
    let row = 0;
    if (rowEl) {
      const explicit = rowEl.getAttribute('row-index');
      row = explicit !== null ? Number(explicit) : 0;
      if (!Number.isFinite(row)) row = 0;
    }
    let col = 0;
    if (rowEl && rowEl.querySelectorAll) {
      try {
        const cells = Array.from(rowEl.querySelectorAll('[role="gridcell"],[role="columnheader"],[role="cell"]'));
        const index = cells.indexOf(el);
        col = index >= 0 ? index : 0;
      } catch {
        col = 0;
      }
    }
    return { row, col };
  }
  if (role === 'row') {
    const explicit = el.getAttribute('row-index');
    const row = explicit !== null ? Number(explicit) : 0;
    return { row: Number.isFinite(row) ? row : 0, col: 0 };
  }
  void collectedIndex;
  return null;
}

function inputStateOf(el: ElementLike, role: string | null): 'empty' | 'filled' | null {
  const tag = tagOf(el);
  if (!(tag === 'INPUT' || tag === 'TEXTAREA' || el.hasAttribute('contenteditable'))) {
    if (role === 'combobox' || role === 'textbox' || role === 'searchbox') {
      return normalizeText((el as { value?: string }).value ?? el.textContent) ? 'filled' : 'empty';
    }
    return null;
  }
  if (tag === 'INPUT' && String((el as { type?: string }).type ?? el.getAttribute('type') ?? '').toLowerCase() === 'checkbox') {
    return ((el as { checked?: boolean }).checked === true) ? 'filled' : 'empty';
  }
  const value = String((el as { value?: string }).value ?? '');
  return value.length > 0 ? 'filled' : 'empty';
}

function domValueOf(el: ElementLike): { domValue?: string; domChecked?: boolean; masked?: boolean } {
  const tag = tagOf(el);
  if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
    if (el.hasAttribute('contenteditable')) {
      const text = normalizeText(el.textContent);
      return text ? { domValue: text.slice(0, 200) } : {};
    }
    return {};
  }
  const type = String((el as { type?: string }).type ?? el.getAttribute('type') ?? '').toLowerCase();
  if (type === 'checkbox' || type === 'radio') {
    return { domChecked: (el as { checked?: boolean }).checked === true };
  }
  if (type === 'password') {
    // 密码不回传明文：只回遮蔽值（页面事实的脱敏投影）。
    const value = String((el as { value?: string }).value ?? '');
    return value ? { domValue: '********', masked: true } : { domValue: '' };
  }
  const value = String((el as { value?: string }).value ?? el.getAttribute('value') ?? '');
  return value ? { domValue: value.slice(0, 500) } : { domValue: '' };
}

function markerHint(el: ElementLike, role: string): string | null {
  const markers = semanticMarkersOf(el, role);
  if (markers.some((marker) => marker.includes('draggable'))) return 'draggable';
  if (markers.some((marker) => marker.includes('drop-target'))) return 'drop-target';
  if (markers.some((marker) => marker.includes('drag-handle'))) return 'drag-handle';
  return null;
}

function scoreOf(node: { role: string; visible: boolean; clickable: boolean; inForm: boolean }): number {
  let score = 10;
  if (node.clickable) score += 40;
  if (node.inForm) score += 10;
  if (node.visible) score += 10;
  if (node.role === 'heading') score += 5;
  if (node.role === 'textbox' || node.role === 'combobox') score += 15;
  return Math.min(100, score);
}

/** 表格/网格表头摘要（表头来自 thead/th、role=columnheader 或首行 th）。 */
function headersOf(el: ElementLike): string[] {
  const explicit = (() => {
    try {
      const list = el.querySelectorAll?.('[role="columnheader"]');
      return list ? Array.from(list).map((item) => normalizeText(item.textContent)).filter(Boolean) : [];
    } catch {
      return [];
    }
  })();
  if (explicit.length) return explicit.slice(0, 24);
  const thead = (() => {
    try {
      const list = el.querySelectorAll?.('thead th');
      return list ? Array.from(list).map((item) => normalizeText(item.textContent)).filter(Boolean) : [];
    } catch {
      return [];
    }
  })();
  if (thead.length) return thead.slice(0, 24);
  try {
    const first = el.querySelector?.('tr');
    const ths = first?.querySelectorAll?.('th');
    if (ths && ths.length) return Array.from(ths).map((item) => normalizeText(item.textContent)).filter(Boolean).slice(0, 24);
  } catch {
    // 忽略
  }
  return [];
}

/** 表格汇总：table / role=table|grid 元素 → 表头与行数（不做单元格内容导出，extract 负责）。 */
export function collectTables(env: DomEnvironment, collected: Collected[]): RichTable[] {
  const tables: RichTable[] = [];
  const seen = new Set<ElementLike>();
  const candidates: ElementLike[] = [];
  for (const item of collected) {
    const tag = tagOf(item.el);
    const role = roleOfElement(item.el);
    if (tag === 'TABLE' || role === 'table' || role === 'grid') {
      if (!seen.has(item.el)) {
        seen.add(item.el);
        candidates.push(item.el);
      }
    }
  }
  for (const el of candidates.slice(0, 32)) {
    const headers = headersOf(el);
    if (!headers.length) continue;
    let rows = 0;
    try {
      const tag = tagOf(el);
      if (tag === 'TABLE') rows = el.querySelectorAll?.('tbody tr').length ?? 0;
      else rows = el.querySelectorAll?.('[role="row"]').length ?? 0;
    } catch {
      rows = 0;
    }
    const role = String(roleOfElement(el) ?? (tagOf(el) === 'TABLE' ? 'table' : ''));
    tables.push({
      id: String(el.id || 'table-' + String(tables.length + 1)),
      label: normalizeText(el.getAttribute('aria-label') ?? el.getAttribute('summary') ?? ''),
      role,
      headers,
      rows,
      columns: headers.length,
      frameId: 0,
    });
    void env;
  }
  return tables;
}

/** 固定/高 z-index 大覆盖层识别（阻挡层事实；覆盖面积 > 15% 才计入，避免误报）。 */
export function collectBlockingLayers(env: DomEnvironment, collected: Collected[]): RichBlockingLayer[] {
  const layers: RichBlockingLayer[] = [];
  const viewportWidth = Number(env.window.innerWidth ?? 0) || 1;
  const viewportHeight = Number(env.window.innerHeight ?? 0) || 1;
  const viewportArea = viewportWidth * viewportHeight;
  for (const item of collected) {
    const el = item.el;
    if (!isVisible(env, el)) continue;
    const role = roleOfElement(el) ?? '';
    const style = styleOf(env, el) as { position?: string; zIndex?: string };
    const position = String(style.position ?? '');
    const zIndex = Number(String(style.zIndex ?? '').replace('auto', ''));
    const bounds = boundsOf(el);
    if (bounds.width < 20 || bounds.height < 20) continue;
    const coverage = (bounds.width * bounds.height) / viewportArea;
    const looksModal = role === 'dialog' || role === 'alertdialog'
      || el.getAttribute('aria-modal') === 'true'
      || (el.getAttribute('role') ?? '') === 'dialog';
    const highZ = Number.isFinite(zIndex) && zIndex >= 1000;
    const fixedLarge = (position === 'fixed' || position === 'absolute') && coverage > 0.15;
    if (!looksModal && !(highZ && coverage > 0.15) && !fixedLarge) continue;
    layers.push({
      id: String(el.id || 'layer-' + String(layers.length + 1)),
      name: accessibleNameOf(el) || '',
      role: role || 'layer',
      coverage: Math.round(coverage * 1000) / 1000,
      bounds,
      zIndex: Number.isFinite(zIndex) ? zIndex : 0,
      position,
    });
  }
  return layers.slice(0, 8);
}

function centerInside(bounds: RichBounds, layer: RichBounds): boolean {
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  return cx >= layer.x && cx <= layer.x + layer.width && cy >= layer.y && cy <= layer.y + layer.height;
}

function axLine(node: Pick<RichAxNode, 'role' | 'name'>): string {
  return '- ' + node.role + (node.name ? ' "' + node.name.slice(0, 160) + '"' : '');
}

/** 逐行 token 估算（CJK≈1、其它≈0.5，至少 1；只做诊断口径，不作计费）。 */
export function estimateVomLineTokens(line: string): number {
  let tokens = 0;
  for (const char of String(line ?? '')) {
    const code = char.codePointAt(0) ?? 0;
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf)
      || (code >= 0x3040 && code <= 0x30ff) || (code >= 0xac00 && code <= 0xd7af)) tokens += 1;
    else tokens += 0.5;
  }
  return Math.max(1, Math.round(tokens));
}

/**
 * 构建 observe 高级载荷。
 *
 * @param built 基础 observe 结果（ref 分配已确定，保证 ref 表与 rich nodes 一致）
 * @param context documentId/frameId/cdpSessionId（视觉对象的 stableRef 与 background ref 注册表对齐）
 */
export function buildRichObservation(
  env: DomEnvironment,
  built: BuiltObservation,
  options: RichOptions = {},
  context: RichObservationContext = {},
): RichResult {
  const started = Date.now();
  const { collected, shadowRoots } = collectElements(env);
  const refByElement = new Map<ElementLike, string>();
  for (const [ref, element] of built.refsByHandle) refByElement.set(element, ref);
  const elementById = assignRichElementIds(collected);
  const elementByNodeId = new Map<string, ElementLike>();
  for (const item of collected) {
    const id = elementById.get(item.el);
    if (id && !elementByNodeId.has(id)) elementByNodeId.set(id, item.el);
  }
  const frames = (() => {
    try {
      return env.document.querySelectorAll?.('iframe,frame').length ?? 0;
    } catch {
      return 0;
    }
  })();
  const layers = collectBlockingLayers(env, collected);
  const result: RichResult = {};
  const nodes: RichNode[] = [];
  const allNodes: RichNode[] = [];
  for (const item of collected) {
    const el = item.el;
    const tag = tagOf(el);
    if (!tag || SKIPPED_TAGS.has(tag)) continue;
    const role = roleOfElement(el);
    const visible = isVisible(env, el);
    const interactive = isActionableRole(role) && visible;
    const domId = el.id ? String(el.id) : null;
    const structural = CONTAINER_TAGS.has(tag) || domId !== null;
    if (!role && !structural) continue;
    if (!visible && !structural) continue;
    const name = accessibleNameOf(el);
    const rect = rectOf(el);
    const bounds = { x: rect.left, y: rect.top, width: rect.width, height: rect.height, left: rect.left, top: rect.top };
    const { domValue, domChecked } = domValueOf(el);
    const node: RichNode = {
      id: String(elementById.get(el) ?? 'n' + String(allNodes.length + 1)),
      ref: refByElement.get(el) ?? null,
      role: role ?? (tag === 'DIV' ? 'container' : tag.toLowerCase()),
      name,
      tag: tag.toLowerCase(),
      domId,
      rect: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
      bounds,
      visible,
      pointerEvents: String((styleOf(env, el) as { pointerEvents?: string }).pointerEvents ?? 'auto'),
      clickable: interactive,
      interactive,
      disabled: disabledOf(el),
      inForm: inFormOf(el),
      inputState: inputStateOf(el, role),
      dragHint: markerHint(el, role ?? ''),
      paintOrder: item.order,
      domPaintOrder: item.order,
      vomScore: scoreOf({ role: role ?? '', visible, clickable: interactive, inForm: inFormOf(el) }),
      backendNodeId: item.order + 1,
      backendNodeSource: 'dom-order',
      ancestors: [],
      table: tableCoordOf(el, elementById),
      ...(domValue !== undefined ? { domValue } : {}),
      ...(domChecked !== undefined ? { domChecked } : {}),
      formStateStale: false,
    };
    allNodes.push(node);
    const keep = options.vom === true || options.vomDeep === true || options.facts === true || options.ax === true;
    if (keep || interactive || Boolean(role)) nodes.push(node);
  }
  // 祖先链（只记录同样进入载荷的节点；用于 VOM relations 的 contains 边）。
  const byId = new Map<string, RichNode>();
  for (const node of nodes) byId.set(node.id, node);
  for (const item of collected) {
    const id = elementById.get(item.el);
    if (!id) continue;
    const node = byId.get(id);
    if (!node) continue;
    const chain: string[] = [];
    let parent: ElementLike | null = item.el.parentElement ?? null;
    let guard = 0;
    while (parent && guard < 32) {
      const parentId = elementById.get(parent);
      if (parentId && byId.has(parentId)) chain.push(parentId);
      parent = parent.parentElement ?? null;
      guard += 1;
    }
    node.ancestors = chain;
  }
  const axNodes: RichAxNode[] = [];
  const axIdByNode = new Map<RichNode, string>();
  const axNodeOf = (node: RichNode): RichAxNode | null => {
    if (!node.role || node.role === 'container') return null;
    if (!node.visible && node.rect.w === 0 && node.rect.h === 0) return null;
    return {
      id: 'ax' + String(axNodes.length + 1),
      role: node.role,
      name: node.name,
      tag: node.tag,
      bounds: node.bounds,
      visible: node.visible,
      interactive: node.interactive,
      backendNodeId: node.backendNodeId,
      table: node.table,
      ref: node.ref,
    };
  };
  for (const node of nodes) {
    const ax = axNodeOf(node);
    if (ax) {
      axNodes.push(ax);
      axIdByNode.set(node, ax.id);
    }
  }
  // AX ↔ VOM 合并：同一 DOM 元素派生 → backendNodeId 直接对齐（byBounds 留 0，不虚构）。
  const axByBackend = new Map<number, RichAxNode>();
  for (const ax of axNodes) axByBackend.set(ax.backendNodeId, ax);
  let matched = 0;
  let interactiveMatched = 0;
  for (const node of nodes) {
    const ax = axByBackend.get(node.backendNodeId);
    if (!ax) continue;
    matched += 1;
    if (node.interactive) interactiveMatched += 1;
    node.ax = { role: ax.role, name: ax.name, backendNodeId: ax.backendNodeId, nodeId: ax.id };
  }
  const axText = axNodes.map((node) => axLine(node)).join('\n');
  const interactions = nodes.filter((node) => node.interactive).length;
  const facts = {
    nodes: nodes.length,
    axMatched: matched,
    vomMatched: matched,
    source: 'dom-snapshot' as const,
    shadowRoots,
    frames,
    limitations: [...RICH_LIMITATIONS],
  };
  const tables = collectTables(env, collected);
  for (const node of nodes) {
    if (!node.table) continue;
    const layer = layers.find((candidate) => centerInside(node.bounds, candidate.bounds));
    if (layer) (node as RichNode & { underBlockingLayer?: boolean }).underBlockingLayer = true;
  }
  const wantsVom = options.vom === true || options.vomDeep === true || options.facts === true || options.ax === true;
  let vomFacts: VomPageFacts | null = null;
  let vomSummary: VomUnifiedSummary | null = null;
  if (options.vom === true) {
    const elapsed = Date.now() - started;
    // 1) DOM 事实抽取（vom-facts.ts）→ packages/vom 统一摘要（vom-summary.ts）。
    //    注意：这里不判定 affordance/关系/上下文，只把 rich 节点 + 元素属性投影成 facts。
    //    先算 facts 再回填深水区事实：深水区会改 clickable（遮挡/pointer-events），
    //    affordance 判定必须基于“动作前”的页面事实，否则深水区事实会反过来污染语义。
    vomFacts = buildVomPageFacts({
      url: built.url,
      title: built.title,
      env,
      nodes,
      elements: collected.map((item) => item.el),
      elementById,
      limits: { ...VOM_FACTS_LIMITS },
    });
    vomSummary = buildVomSummary(vomFacts);
    const violations = verifyVomSummary(vomSummary);
    const affordanceById = new Map(vomSummary.nodes.map((view) => [view.id, view.affordance]));
    for (const node of nodes) {
      const affordance = affordanceById.get(node.id);
      if (affordance) node.affordance = affordance;
    }
    // 2) VOM 深水区（vom-deep.ts）：命中测试/屏外/对比度/遮挡 → 回填节点字段。
    const issues = createVomCaptureIssues();
    // deepFacts=false 只用于夹具生成：facts JSON 必须与运行时“深水区回填前”的页面事实一致。
    const deepEnabled = options.deepFacts !== false;
    let visibilityMs = 1;
    let semanticsMs = 1;
    let visualObjects: VomVisualObject[] = [];
    let deepLayers: VomLayerBand[] = [];
    let graphPayload: VomGraphPayload = {
      available: false,
      nodes: [],
      edges: [],
      roots: [],
      counts: { nodes: 0, edges: 0, byType: {} },
      truncated: false,
    };
    if (deepEnabled) {
      const visibilityStarted = Date.now();
      try {
        applyDeepNodeFacts(env, nodes.map((node) => ({
          node: node as VomDeepNodeLike,
          element: elementByNodeId.get(node.id) ?? null,
        })));
      } catch (error) {
        issues.note('visibility', error);
      }
      visibilityMs = Math.max(1, Date.now() - visibilityStarted);
      // 3) 视觉对象（canvas/图片/自绘区域 + 可动作 ref 的 stableRef）与 paint-order 分层。
      const semanticsStarted = Date.now();
      try {
        visualObjects = collectVisualObjects({
          env,
          collected,
          nodes,
          context: {
            documentId: String(context.documentId ?? ''),
            frameId: Number.isInteger(context.frameId) ? Number(context.frameId) : 0,
            cdpSessionId: context.cdpSessionId ?? null,
          },
        }).objects;
      } catch (error) {
        issues.note('visual', error);
      }
      try {
        deepLayers = buildLayerFacts(env, collected);
      } catch (error) {
        issues.note('paint', error);
      }
      semanticsMs = Math.max(1, Date.now() - semanticsStarted);
      // 4) 页面图 → 公开图（containment/ownership/roots；--ax 时并入 AX 父子边）。
      try {
        const iframeElements = (() => {
          try {
            const list = env.document.querySelectorAll?.('iframe');
            return list ? Array.from(list) : [];
          } catch {
            return [];
          }
        })();
        const refByNodeId = new Map<string, string>();
        for (const node of nodes) if (node.ref) refByNodeId.set(node.id, node.ref);
        // 观察节点必须在 buildVomGraph 之前带 graphKey/vomId：前者把原始图节点映射回 rich 节点，
        // 后者让公开 id 用 rich 节点 id（否则会退化成 @eN ref，与 vom.nodes[].ancestorIds 对不上）。
        for (const node of nodes) {
          node.graphKey = node.id;
          node.vomId = node.id;
        }
        const rawGraph = buildPageGraph({
          url: built.url,
          collected,
          elementById,
          refByNodeId,
          iframeElements,
        });
        const observedNodes = nodes as unknown as VomGraphObservedNode[];
        const builtGraph = buildVomGraph({
          graph: rawGraph,
          nodes: observedNodes,
          limits: { nodes: VOM_GRAPH_DEFAULT_LIMITS.nodes, edges: VOM_GRAPH_DEFAULT_LIMITS.edges },
        });
        graphPayload = builtGraph.payload;
        for (const node of nodes) {
          node.graphKey = node.id;
          const info = builtGraph.info.get(node);
          if (!info) continue;
          node.parentId = info.parentId || null;
          node.ancestorIds = info.ancestorIds.slice();
        }
        if (options.ax === true) {
          const axEntries: VomAxEntry[] = [];
          for (const [node, axId] of axIdByNode) {
            axEntries.push({
              axId,
              element: elementByNodeId.get(node.id) ?? null,
              role: node.ax?.role ?? node.role,
            });
          }
          const merged = mergeAxIntoGraph(graphPayload, {
            axNodes: buildAxProjection(axEntries),
            nodes: observedNodes,
            info: builtGraph.info,
            limits: { edges: AX_GRAPH_LIMITS.edges, nodes: AX_GRAPH_LIMITS.nodes },
          });
          graphPayload = merged.graph;
        }
      } catch (error) {
        issues.note('relations', error);
      }
    }
    for (const node of nodes) {
      if (!node.graphKey) node.graphKey = node.id;
      if (node.ancestorIds === undefined) node.ancestorIds = node.ancestors.slice();
    }
    const edges: RichVomEdge[] = graphPayload.edges.map((edge) => (edge.type === 'child'
      ? { type: edge.type, from: edge.from, to: edge.to, child: edge.to, parent: edge.from }
      : { type: edge.type, from: edge.from, to: edge.to }));
    const vomStages: RichVomStage[] = [
      { stage: 'facts', ok: nodes.length > 0, count: collected.length, ms: Math.max(1, elapsed) },
      { stage: 'identity', ok: nodes.length > 0, count: nodes.filter((node) => node.ref !== null).length, ms: 1 },
      { stage: 'relations', ok: graphPayload.counts.edges > 0, count: graphPayload.counts.edges, ms: 1 },
      { stage: 'layout', ok: nodes.some((node) => node.bounds.width > 0), count: nodes.filter((node) => node.bounds.width > 0).length, ms: 1 },
      { stage: 'paint', ok: deepLayers.length > 0, count: deepLayers.length, ms: semanticsMs },
      { stage: 'interact', ok: true, count: nodes.filter((node) => node.clickable === true).length, ms: visibilityMs },
    ];
    result.vom = {
      version: 1,
      source: 'packages/vom',
      stats: {
        members: nodes.length,
        edges: edges.length,
        interactive: interactions,
        relations: vomSummary.stats.relations,
        groups: vomSummary.groups.total,
        affordance: vomSummary.affordance.total,
      },
      stages: vomStages,
      nodes,
      edges,
      affordance: vomSummary.affordance,
      graph: graphPayload,
      counts: graphPayload.counts,
      visual: visualObjects,
      issues: issues.issues,
      selfCheck: { ok: violations.length === 0, violations },
      limitations: [...RICH_LIMITATIONS, ...VOM_DEEP_LIMITATIONS, ...vomSummary.limitations],
    };
    // 顶层字段与 JS observe 同名同形：relations/context/groups 直接由 packages/vom 产出；
    // visualObjects/layers/issues/stages 是 VOM 深水区字段（JS observe 同名字段）。
    result.vomAffordance = vomSummary.affordance;
    result.relations = vomSummary.relations;
    result.context = vomSummary.context;
    result.groups = vomSummary.groups;
    result.visualObjects = visualObjects;
    result.layers = deepLayers;
    result.issues = issues.issues;
    result.vomSummaryText = renderVomSummaryText(vomSummary);
    // semantic 仍保留既有版本/成员字段；groups 来自 packages/vom context（不再写死 0）。
    result.semantic = { version: 1, stats: { members: nodes.length, groups: vomSummary.groups.total } };
    result.ariaSnapshot = axText;
    result.nodes = nodes;
    // 5) 顶层阶段指标：与 JS 页面库 finishFunnel 同口径，供 CLI/E2E 读取。
    const observationLines = String(built.observation ?? '').split('\n');
    let tokens = 0;
    let maxLineTokens = 0;
    for (const line of observationLines) {
      const cost = estimateVomLineTokens(line);
      tokens += cost;
      if (cost > maxLineTokens) maxLineTokens = cost;
    }
    const walkMs = Math.max(0, Date.now() - started);
    result.stages = {
      visited: collected.length,
      hidden: Math.max(0, collected.length - nodes.length),
      stealth: 0,
      skippedTag: 0,
      emitted: nodes.length,
      refs: nodes.filter((node) => node.ref !== null).length,
      truncated: built.truncated === true,
      iframes: frames,
      tokens,
      lineTokens: tokens,
      maxLineTokens,
      ms: {
        walk: walkMs,
        visibility: visibilityMs,
        stealth: 0,
        semantics: Math.max(0, walkMs - visibilityMs - semanticsMs),
      },
    };
  }
  // --vom 的权重/计费/预算管线（5b）：接在语义关系/深水区事实之后，只裁 nodes 数组。
  // 结果字段名与 JS observe.vomWeights 同形（E2E 5b 直接消费）；nodes 与 vom.nodes 是
  // 同一个数组引用，原地 splice 保证两处一致。
  if (options.vom === true) {
    const pipeline = applyVomWeights(
      nodes,
      (vomSummary?.context?.groups ?? []) as unknown as Array<{ id: string; memberIds?: string[]; tokens?: number; groupKind?: string; parentId?: string | null }>,
      contextStatsOf(vomSummary?.context ?? null),
      options.weights ?? {},
    );
    const kept = pipeline.nodes as RichNode[];
    nodes.length = 0;
    nodes.push(...kept);
    result.nodes = nodes;
    if (result.vom) {
      result.vom.nodes = nodes;
      result.vom.stats.members = nodes.length;
      result.vom.stats.interactive = nodes.filter((node) => node.interactive === true).length;
    }
    result.vomWeights = pipeline.vomWeights;
    if (pipeline.vomExplain) result.vomExplain = pipeline.vomExplain;
    result.semantic = { version: 1, stats: { members: nodes.length, groups: result.vom ? result.vom.stats.groups : 0 } };
    // stages 的 emitted/refs 跟着预算后的节点数走（不把裁剪前的计数当最终事实）。
    if (result.stages) {
      result.stages.emitted = nodes.length;
      result.stages.refs = nodes.filter((node) => node.ref !== null).length;
    }
    result.ariaSnapshot = nodes
      .filter((node) => Boolean(node.role) && node.role !== 'container')
      .map((node) => axLine({ role: node.role, name: node.name }))
      .join('\n');
  }
  attachStableRefs(nodes, context);
  if (options.vomDeep === true) {
    const ordered = nodes
      .slice()
      .sort((a, b) => (a.bounds.y - b.bounds.y) || (a.bounds.x - b.bounds.x) || (a.domPaintOrder - b.domPaintOrder));
    const droppedReasons = [{ reason: 'not-semantic', count: Math.max(0, collected.length - nodes.length) }];
    result.deepVom = {
      nodes: ordered,
      stages: {
        collected: collected.length,
        emitted: ordered.length,
        sorted: 'paint-order',
        tokens: ordered.reduce((sum, node) => sum + node.role.length + node.name.length + 8, 0),
        interactions,
      },
      vomFunnel: { collected: collected.length, emitted: ordered.length, droppedReasons },
      limitations: [...RICH_LIMITATIONS],
    };
  }
  if (options.ax === true) {
    result.axNodes = axNodes;
    // matched 只统计“可交互且 AX 合并成功”的节点（与 page-lib interactiveTotal 同量纲）。
    result.axJoin = {
      matched: interactiveMatched,
      byBackendNodeId: interactiveMatched,
      byBounds: 0,
      unmatched: Math.max(0, interactions - interactiveMatched),
      total: axNodes.length,
    };
    result.unmappedAx = [];
    if (options.vom !== true) result.nodes = nodes;
  }
  if (options.facts === true) {
    result.facts = facts;
    if (options.vom !== true) result.nodes = nodes;
  }
  if (options.fallbackAx === true) {
    result.fallback = 'ax';
    result.observation = axText;
    result.nodes = [];
    result.tables = tables;
  }
  if (options.pipeline === 'ax') {
    result.pipeline = 'ax';
    // AX 管线：不带 @eN ref（没有 page-lib ref 表），节点来自 AX 摘要但保留几何/交互标记。
    const byBackend = new Map<number, RichNode>();
    for (const node of nodes) byBackend.set(node.backendNodeId, node);
    result.nodes = axNodes.map((ax) => {
      const base = byBackend.get(ax.backendNodeId);
      return base ? { ...base, ref: null } as RichNode : null;
    }).filter((node): node is RichNode => node !== null);
    result.observation = axText;
    result.axNodes = axNodes;
  }
  if (options.compareAx === true) {
    const pageLines = String(built.observation ?? '').split('\n').filter((line) => line.trim().length > 0);
    const axLines = axText.split('\n').filter((line) => line.trim().length > 0);
    const interactiveTotal = nodes.filter((node) => node.interactive).length;
    const coverage = interactiveTotal > 0 ? Math.round((interactiveMatched / interactiveTotal) * 1000) / 1000 : 0;
    result.pipelineCompare = {
      pageLib: { refs: built.refs, lines: pageLines.length },
      ax: { nodes: axNodes.length, lines: axLines.length },
      interactiveTotal,
      matched: interactiveMatched,
      axCoverage: coverage,
      limitations: [...RICH_LIMITATIONS],
    };
  }
  if (wantsVom || options.fallbackAx === true || options.pipeline === 'ax' || options.compareAx === true) {
    if (result.nodes === undefined) result.nodes = nodes;
    result.tables = tables;
    result.blockingLayers = layers;
    result.ariaSnapshot = result.ariaSnapshot ?? axText;
  }
  if (options.debugSurfaces === true) {
    const surfaces = 'surfaces iframes=' + String(frames) + ' frames=' + String(frames + 1) + ' shadowRoots=' + String(shadowRoots)
      + ' blockingLayers=' + String(layers.length) + '（DOM 诊断；无 CDP 的渲染面不可见）';
    result.debugSurfaces = surfaces;
    result.observation = String(built.observation ?? '') + '\n- ' + surfaces;
  }
  return result;
}

/**
 * 给 rich 节点补 stableRef（5b）：与 background `refDetails` 使用同一套 identity/hash。
 *
 * 顺序与 background 完全一致：按 nodes 顺序、只统计 ref 以 `@e` 开头的节点、
 * 同 identity 用出现序号区分。因此 `refs negotiate <node.stableRef>` 能命中注册表。
 */
export function attachStableRefs(
  nodes: readonly RichNode[],
  context: RichObservationContext = {},
): void {
  const documentId = String(context.documentId ?? '');
  const frameId = Number.isInteger(context.frameId) ? Number(context.frameId) : 0;
  const cdpSessionId = context.cdpSessionId ? String(context.cdpSessionId) : null;
  const used = new Map<string, number>();
  for (const node of nodes) {
    if (!node || typeof node.ref !== 'string' || !node.ref.startsWith('@e')) continue;
    const identity = refIdentityOf({
      cdpSessionId,
      documentId,
      frameId,
      tag: node.tag,
      id: node.id,
      role: node.role,
      name: node.name,
    });
    const identityKey = refIdentityKeyOf(identity);
    const count = (used.get(identityKey) ?? 0) + 1;
    used.set(identityKey, count);
    node.stableRef = refStableRefOf(identity, count);
  }
}

// ---------------------------------------------------------------------------
// closed shadow / 未映射 AX 的只读合并（20v / 5f）
//
// 数据源在 background（CDP DOM.pierce / Accessibility），内容脚本只做：
// - closed shadow：编号 @eN（接在主文档 ref 之后）+ 写观察行 + 回传条目给 background 登记；
// - 未映射 AX：按 JS renderUnmappedAx 的行格式补“未映射的可交互元素”段（无 ref）。
// ---------------------------------------------------------------------------

function boundsLikeOf(value: unknown): { x: number; y: number; width: number; height: number } | null {
  if (!value || typeof value !== 'object') return null;
  const bag = value as Record<string, unknown>;
  const x = Number(bag['x'] ?? 0);
  const y = Number(bag['y'] ?? 0);
  const width = Number(bag['width'] ?? bag['w'] ?? 0);
  const height = Number(bag['height'] ?? bag['h'] ?? 0);
  if (![x, y, width, height].every((item) => Number.isFinite(item))) return null;
  return { x, y, width, height };
}

const ROLE_BY_TAG: Readonly<Record<string, string>> = Object.freeze({
  button: 'button',
  a: 'link',
  input: 'textbox',
  select: 'combobox',
  textarea: 'textbox',
  label: 'label',
  summary: 'button',
  details: 'group',
  option: 'option',
});

/** closed shadow 候选 → 观察条目（编号接在主文档 ref 之后；文与 JS 同形）。 */
export function mergeClosedShadowEntries(input: {
  observation: string;
  startRef: number;
  candidates: readonly unknown[];
}): { observation: string; entries: ContentClosedShadowEntry[]; nextRef: number } {
  const candidates = Array.isArray(input.candidates) ? input.candidates : [];
  const entries: ContentClosedShadowEntry[] = [];
  let next = Math.max(0, Math.floor(Number(input.startRef) || 0)) + 1;
  const lines: string[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const bag = candidate as Record<string, unknown>;
    const text = String(bag['text'] ?? bag['name'] ?? '').trim().slice(0, 160);
    const tag = String(bag['tag'] ?? 'div').toLowerCase();
    if (!text) continue;
    const backendNodeId = Number(bag['backendNodeId']);
    const role = String(bag['role'] ?? ROLE_BY_TAG[tag] ?? tag);
    const name = String(bag['name'] ?? text).trim().slice(0, 160) || text;
    const entry: ContentClosedShadowEntry = {
      ref: '@e' + String(next),
      text,
      tag,
      role,
      name,
      backendNodeId: Number.isInteger(backendNodeId) && backendNodeId > 0 ? backendNodeId : null,
      bounds: boundsLikeOf(bag['bounds']),
      via: 'closed-shadow-ref',
      source: 'closed-shadow',
    };
    next += 1;
    entries.push(entry);
    // 行格式与 JS 页面库一致：`- @eN tag "text"  (closed shadow)`。
    lines.push('- ' + entry.ref + ' ' + tag + ' ' + JSON.stringify(text) + '  (closed shadow)');
  }
  const base = String(input.observation ?? '');
  const observation = lines.length ? (base ? base + '\n' : '') + lines.join('\n') : base;
  return { observation, entries, nextRef: next - 1 };
}

/** 未映射可交互元素 → 观察里追加“未映射的可交互元素”段（无 ref，仅供定位）。 */
export function mergeUnmappedAxEntries(input: {
  observation: string;
  candidates: readonly unknown[];
  source?: 'dom-aria' | 'closed-shadow';
}): { observation: string; entries: ContentUnmappedAxEntry[] } {
  const candidates = Array.isArray(input.candidates) ? input.candidates : [];
  const entries: ContentUnmappedAxEntry[] = [];
  const lines: string[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const bag = candidate as Record<string, unknown>;
    const backendNodeId = Number(bag['backendNodeId']);
    if (!Number.isInteger(backendNodeId) || backendNodeId <= 0) continue;
    const name = String(bag['name'] ?? bag['text'] ?? '').trim().slice(0, 100);
    const role = String(bag['role'] ?? '').trim() || 'generic';
    const bounds = boundsLikeOf(bag['bounds']);
    const source = (bag['source'] === 'closed-shadow' ? 'closed-shadow' : (input.source ?? 'dom-aria')) as
      ContentUnmappedAxEntry['source'];
    entries.push({ role, name, backendNodeId, bounds, source });
    const geometry = bounds
      ? ' (@' + String(Math.round(bounds.x)) + ',' + String(Math.round(bounds.y)) + ' '
        + String(Math.round(bounds.width)) + 'x' + String(Math.round(bounds.height)) + ')'
      : '';
    const label = name ? ' ' + JSON.stringify(name) : '';
    lines.push('- ' + role + label + geometry + '  [仅供定位，无 ref]');
  }
  if (!entries.length) return { observation: String(input.observation ?? ''), entries };
  const section = '── 未映射的可交互元素（AX/DOMSnapshot，仅供定位）──\n' + lines.join('\n');
  const base = String(input.observation ?? '');
  return { observation: base ? base + '\n\n' + section : section, entries };
}

/** closed shadow 候选里带几何的条目可直接作为未映射 AX 证据（5f 的 closed shadow 补充）。 */
export function closedShadowAsUnmappedAx(
  candidates: readonly unknown[],
): ContentUnmappedAxCandidate[] {
  const out: ContentUnmappedAxCandidate[] = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (!candidate || typeof candidate !== 'object') continue;
    const bag = candidate as Record<string, unknown>;
    const backendNodeId = Number(bag['backendNodeId']);
    if (!Number.isInteger(backendNodeId) || backendNodeId <= 0) continue;
    const tag = String(bag['tag'] ?? 'div').toLowerCase();
    out.push({
      role: String(bag['role'] ?? ROLE_BY_TAG[tag] ?? tag),
      name: String(bag['name'] ?? bag['text'] ?? '').trim().slice(0, 100),
      backendNodeId,
      bounds: boundsLikeOf(bag['bounds']),
      source: 'closed-shadow',
    });
  }
  return out;
}
