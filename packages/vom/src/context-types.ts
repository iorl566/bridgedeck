// packages/vom/src/context-types.ts —— VOM 语义上下文/分组的类型面。
//
// 对应实现：src/context.ts（landmark / 表单 / 表格上下文链 + 组结构事实）。
//
// 输入是观测已产生的事实（payload entries + 页面图 + frame 列表），全部 optional：
// 页面事实可能来自旧 payload 或第三方页面库；输出是严格类型，调用方直接读结构事实。

// ---------------------------------------------------------------------------
// 分组种类
// ---------------------------------------------------------------------------

/** 上下文组种类：landmark（地标）/ form（表单）/ table（表格）。 */
export type ContextKind = 'landmark' | 'form' | 'table';

/** 分类命中：一个祖先（或节点自身）构成哪种上下文锚点。 */
export interface ContextAnchorClassification {
  kind: ContextKind;
  groupKind: string;
  role: string | null;
  tag: string | null;
}

/** 表单控件角色/标签的上下文锚点判定入参。 */
export interface ContextAnchorFacts {
  readonly role?: unknown;
  readonly tag?: unknown;
}

// ---------------------------------------------------------------------------
// 输入事实
// ---------------------------------------------------------------------------

/** 祖先事实（页面侧 ancestors 项）。 */
export interface ContextAncestorFact {
  readonly id?: unknown;
  readonly ref?: unknown;
  readonly role?: unknown;
  readonly tag?: unknown;
  readonly name?: unknown;
}

/** 页面侧表格结构事实（tableFacts）。 */
export interface PageTableFacts {
  readonly headers?: unknown;
  readonly dataRows?: unknown;
  readonly caption?: unknown;
}

/** 节点事实（上下文层用到的字段子集）。 */
export interface ContextNodeFacts {
  readonly id?: unknown;
  readonly role?: unknown;
  readonly tag?: unknown;
  readonly name?: unknown;
  readonly ancestors?: unknown;
  readonly tableFacts?: PageTableFacts | null;
}

/** 页面图节点。 */
export interface ContextGraphNodeFacts {
  readonly id?: unknown;
  readonly domId?: unknown;
  readonly role?: unknown;
  readonly tag?: unknown;
  readonly name?: unknown;
  readonly parentId?: unknown;
}

/** 页面图边。 */
export interface ContextGraphEdgeFacts {
  readonly type?: unknown;
  readonly from?: unknown;
  readonly to?: unknown;
}

/** 页面图。 */
export interface ContextGraphFacts {
  readonly nodes?: unknown;
  readonly edges?: unknown;
}

/** frame 事实（observe-frames 的 frame 描述）。 */
export interface ContextFrameFacts {
  readonly frameId?: unknown;
  readonly url?: unknown;
  readonly parentFrameId?: unknown;
}

/** 一个观测条目。 */
export interface ContextEntryInput {
  readonly id?: unknown;
  readonly node?: ContextNodeFacts | null;
  readonly ancestorIds?: unknown;
}

/** buildVomContext 的 limits。 */
export interface ContextLimitsInput {
  readonly groups?: unknown;
  readonly contexts?: unknown;
  readonly headers?: unknown;
  readonly depth?: unknown;
}

/** buildVomContext 的输入。 */
export interface BuildVomContextInput {
  readonly entries?: unknown;
  readonly graph?: unknown;
  readonly frames?: unknown;
  readonly limits?: ContextLimitsInput | null;
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

/** 表头单元格事实。 */
export interface VomTableHeader {
  id: string | null;
  role: string;
  name: string;
}

/** 表格组的结构事实（表头 / 行数 / 题注）。 */
export interface VomTableFacts {
  headers: VomTableHeader[];
  headerCount: number;
  rowCount: number;
  caption: string | null;
  hasHeaderRow: boolean;
  /** 仅 page-facts 来源带：数据来自页面侧 tableFacts 而不是页面图推导。 */
  source?: 'page-facts';
}

/** 一个上下文组（landmark / form / table）。 */
export interface VomContextGroup {
  id: string;
  key: string;
  kind: ContextKind;
  groupKind: string;
  anchorId: string;
  role: string | null;
  tag: string | null;
  domId: string | null;
  name: string | null;
  memberIds: string[];
  members: number;
  tokens: number;
  roles: Record<string, number>;
  parentId: string | null;
  childIds: string[];
  depth: number;
  frameId: number | null;
  table?: VomTableFacts;
}

/** 单节点的上下文链（近 → 远：table > form > landmark）。 */
export interface VomNodeContext {
  node: string;
  chain: string[];
  kinds: ContextKind[];
  anchorIds: string[];
  frameId: number | null;
}

/** 跨 frame 上下文的按帧汇总。 */
export interface VomContextFrameSummary {
  frameId: number;
  url: string | null;
  parentFrameId: number | null;
  groups: number;
  groupIds: string[];
  nodes: number;
}

/** 上下文模型统计。 */
export interface VomContextStats {
  groups: number;
  contexts: number;
  byKind: Record<string, number>;
  byGroupKind: Record<string, number>;
  landmarks: number;
  forms: number;
  tables: number;
  parented: number;
  depth: number;
  framed: number;
  tableHeaders: number;
  truncated: boolean;
}

/** buildVomContext 的返回。 */
export interface VomContextModel {
  version: number;
  groups: VomContextGroup[];
  roots: string[];
  contexts: VomNodeContext[];
  frames: VomContextFrameSummary[];
  stats: VomContextStats;
}
