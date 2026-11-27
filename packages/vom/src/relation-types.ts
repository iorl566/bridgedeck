// packages/vom/src/relation-types.ts —— 语义关系图 v3 的类型面（relations + 跨 frame）。
//
// 对应实现：
//   VomRelationGraph / VomRelationRecord / VomRelationGroup  ← src/relations.ts
//   FrameRelationsReport / FrameNodeRecord / FrameRelationRecord ← src/frame-relations.ts
//
// 输入刻意保持“观测事实投影”：字段全部 optional 且可能来自旧 payload / 第三方页面库，
// 因此用 unknown 接、实现里显式 String()/Number() 归一；输出则是严格类型，调用方
// （observe payload / 关系查询 / 诊断）不再猜字段。

// ---------------------------------------------------------------------------
// 关系类型/来源
// ---------------------------------------------------------------------------

/** v3 基线关系类型（五元组，既有导出契约）。 */
export type RelationType = 'contains' | 'labels' | 'controls' | 'owns' | 'describes';

/** 本次扩展新增的关系类型：错误/校验消息使控件处于 invalid 状态。 */
export type InvalidatingRelationType = 'invalidates';

/** 关系图实际支持的全部类型（v3 基线 + invalidates）。 */
export type RelationKind = RelationType | InvalidatingRelationType;

/** 允许“节点指向自己”的关系类型：描述与 invalid 状态是节点自身的属性。 */
export type SelfRelationKind = 'describes' | 'invalidates';

/** 关系来源（哪条证据产生这条边）；决定置信度。 */
export type RelationSource =
  | 'aria-controls'
  | 'aria-labelledby'
  | 'aria-labelledby-chain'
  | 'aria-describedby'
  | 'aria-owns'
  | 'aria-errormessage'
  | 'label-for'
  | 'html-for'
  | 'tab-controls'
  | 'form-anchor'
  | 'invalid-describedby'
  | 'invalid-flag'
  | 'composite-owner'
  | 'semantic-group'
  | 'alt-text'
  | 'node-relations'
  | 'graph-edge'
  | 'dom-parent'
  | 'title-attribute'
  | 'frame-edge'
  | 'frame-owner'
  | 'parent-frame';

/** 跨 frame 关系的来源子集。 */
export type FrameRelationSource = 'frame-edge' | 'frame-owner' | 'parent-frame';

/** 页面图 edge.type → 关系类型（未列出的边不进关系图）。 */
export type GraphEdgeType =
  | 'controls'
  | 'tab-controls'
  | 'label'
  | 'html-for'
  | 'labelledby'
  | 'describedby'
  | 'owns'
  | 'form'
  | 'child'
  | 'errormessage'
  | 'frame';

/** 关系记录上可由证据补充的自由字段（text/via/depth/chain/…）。 */
export type RelationExtra = Record<string, unknown>;

// ---------------------------------------------------------------------------
// 关系记录
// ---------------------------------------------------------------------------

/**
 * 一条语义关系。
 * - type/from/to 是三元组主键（同类型同端点只保留一条，sources 累积）；
 * - confidence 0..1，两位小数；同一条关系多来源时取最大值；
 * - source 是当前最高置信度来源，sources 是全部来源（按出现顺序）；
 * - self=true 表示节点指向自身（describes/invalidates 才允许）。
 */
export interface VomRelationRecord {
  type: RelationKind;
  from: string;
  to: string;
  confidence: number;
  source: RelationSource;
  sources: string[];
  fromRole?: string | null;
  toRole?: string | null;
  self?: true;
  depth?: number;
  chain?: string[];
  text?: string | null;
  via?: string | null;
  frame?: true;
  composite?: string;
  state?: string;
  fromKind?: string | null;
  toKind?: string | null;
  parentFrameId?: number;
  childFrameId?: number;
  frameId?: number;
  [extra: string]: unknown;
}

/** 组上下文：父组、上下文链、深度。 */
export interface VomRelationGroupContext {
  parent: string | null;
  parentKind: string | null;
  depth: number;
  chain: string[];
}

/** 语义组成员 + 上下文。 */
export interface VomRelationGroup {
  id: string;
  kind: string | null;
  members: number;
  tokens: number;
  score: number;
  context: VomRelationGroupContext;
}

/** “父组包含子组”的上下文关系。 */
export interface VomGroupContextRelation {
  id: string;
  parent: string;
  child: string;
  parentKind: string | null;
  childKind: string | null;
  confidence: number;
  source: RelationSource;
}

/** 关系图统计。 */
export interface VomRelationsStats {
  relations: number;
  nodes: number;
  byType: Record<string, number>;
  bySource: Record<string, number>;
  lowConfidence: number;
  averageConfidence: number;
  groups: number;
  contextGroups: number;
  contexts: number;
  truncated: boolean;
  selfRelations: number;
  selfDescriptions: number;
  chainedLabels: number;
  invalidates: number;
  compositeOwns: number;
  frameRelations: number;
  /** filterRelationsByConfidence 附加：本次过滤的置信度下限。 */
  filteredBelow?: number;
}

/** buildVomRelationGraph 的返回。 */
export interface VomRelationGraph {
  version: number;
  relationTypes: RelationType[];
  kinds: RelationKind[];
  relations: VomRelationRecord[];
  groups: VomRelationGroup[];
  contexts: VomGroupContextRelation[];
  frames: FrameNodeRecord[];
  frameStats: FrameRelationsStats | null;
  stats: VomRelationsStats;
}

// ---------------------------------------------------------------------------
// 输入事实
// ---------------------------------------------------------------------------

/** 节点事实（页面侧 formatNode 的字段子集，关系层用到的部分）。 */
export interface RelationNodeFacts {
  readonly id?: unknown;
  readonly role?: unknown;
  readonly tag?: unknown;
  readonly name?: unknown;
  readonly alt?: unknown;
  readonly title?: unknown;
  readonly invalid?: unknown;
  readonly parentId?: unknown;
  /** 页面侧已展开的 labelledby 链事实（每跳带 id/depth/chain/from）。 */
  readonly labelledByChain?: unknown;
  readonly ancestors?: unknown;
}

/** entry.relations：页面观测给出的显式 ARIA 关系（值是 DOM id/名字）。 */
export interface EntryRelationFacts {
  readonly controls?: unknown;
  readonly labelledBy?: unknown;
  readonly describedBy?: unknown;
  readonly labelIds?: unknown;
  readonly owns?: unknown;
  readonly form?: unknown;
  readonly errorMessage?: unknown;
}

/** 一个观测条目。 */
export interface VomEntryInput {
  readonly id?: unknown;
  readonly node?: RelationNodeFacts | null;
  readonly relations?: EntryRelationFacts | null;
  readonly ancestorIds?: unknown;
}

/** 页面图节点。 */
export interface VomGraphNodeFacts {
  readonly id?: unknown;
  readonly domId?: unknown;
  readonly role?: unknown;
  readonly tag?: unknown;
  readonly name?: unknown;
  readonly parentId?: unknown;
  /** frame 子图节点带 url（frame:<id> 节点）；普通节点没有。 */
  readonly url?: unknown;
}

/** 页面图边。 */
export interface VomGraphEdgeFacts {
  readonly type?: unknown;
  readonly from?: unknown;
  readonly to?: unknown;
}

/** 页面图。 */
export interface VomGraphFacts {
  readonly nodes?: unknown;
  readonly edges?: unknown;
  /** 子图可用性/截断/roots（frame 子图带，普通页面图可选）。 */
  readonly available?: unknown;
  readonly truncated?: unknown;
  readonly roots?: unknown;
}

/** 语义图节点（组）。 */
export interface SemanticGroupNodeFacts {
  readonly id?: unknown;
  readonly groupKind?: string | null;
  readonly members?: unknown;
  readonly tokens?: unknown;
  readonly score?: unknown;
}

/** 语义图边。 */
export interface SemanticGroupEdgeFacts {
  readonly type?: unknown;
  readonly from?: unknown;
  readonly to?: unknown;
  readonly fromKind?: string | null;
  readonly toKind?: string | null;
}

/** 语义组图 v2（lib/vom-semantic.js 的输出投影）。 */
export interface SemanticGraphFacts {
  readonly nodes?: unknown;
  readonly edges?: unknown;
}

/** 关系图构建选项。 */
export interface VomRelationLimitsInput {
  readonly relations?: unknown;
  readonly groups?: unknown;
  readonly contexts?: unknown;
  readonly chainDepth?: unknown;
}

/** buildVomRelationGraph 的输入。 */
export interface BuildVomRelationGraphInput {
  readonly entries?: unknown;
  readonly graph?: unknown;
  readonly semantic?: unknown;
  readonly frames?: unknown;
  readonly limits?: VomRelationLimitsInput | null;
}

/** 页面侧 labelledby 链事实的一跳。 */
export interface LabelledByChainHopFact {
  readonly id?: unknown;
  readonly depth?: unknown;
  readonly chain?: unknown;
  readonly from?: unknown;
}

/** 祖先事实（父/声明顺序）。 */
export interface RelationAncestorFact {
  readonly id?: unknown;
  readonly ref?: unknown;
  readonly role?: unknown;
  readonly tag?: unknown;
  readonly name?: unknown;
}

// ---------------------------------------------------------------------------
// 单节点视图（查询/诊断）
// ---------------------------------------------------------------------------

/** relationsForNode 的单条视图。 */
export interface NodeRelationView {
  type: RelationKind;
  direction: 'out' | 'in';
  from: string;
  to: string;
  confidence: number;
  sources: string[];
  self?: true;
  depth?: number;
}

/** labelChainForNode 的单跳视图。 */
export interface LabelChainHop {
  from: string;
  confidence: number;
  source: RelationSource;
  depth: number;
  chain?: string[];
}

// ---------------------------------------------------------------------------
// 跨 frame
// ---------------------------------------------------------------------------

/** 跨 frame 关系记录（frame 节点作为端点）。 */
export interface FrameRelationRecord {
  type: 'contains' | 'owns';
  from: string;
  to: string;
  confidence: number;
  source: FrameRelationSource;
  sources: string[];
  frame: true;
  parentFrameId?: number;
  childFrameId?: number;
  frameId?: number;
  [extra: string]: unknown;
}

/** frame 节点（frame:0 是主帧，role=document）。 */
export interface FrameNodeRecord {
  id: string;
  frameId: number;
  role: 'document' | 'frame';
  url: string | null;
  parentFrameId: number | null;
  ownerNodeId: string | null;
  available: boolean;
  placeholder: boolean;
  nodeCount?: number;
  edgeCount?: number;
  truncated?: boolean;
  roots?: number;
  depth?: number;
}

/** 跨 frame 关系统计。 */
export interface FrameRelationsStats {
  frames: number;
  linked: number;
  orphan: number;
  relations: number;
  crossFrame: number;
  bySource: Record<string, number>;
  roots: number;
  truncated: boolean;
}

/** buildCrossFrameRelations 的返回。 */
export interface FrameRelationsReport {
  version: number;
  frames: FrameNodeRecord[];
  nodes: FrameNodeRecord[];
  relations: FrameRelationRecord[];
  stats: FrameRelationsStats;
  limits: { frames: number; relations: number };
}

/** 一种输入形态：frame 列表项（子图可挂在 graph/vom 上）。 */
export interface FrameGraphSourceInput {
  readonly frameId?: unknown;
  readonly frameNodeId?: unknown;
  readonly url?: unknown;
  readonly parentFrameId?: unknown;
  readonly graph?: VomGraphFacts | null;
  readonly vom?: VomGraphFacts | null;
  readonly nodes?: unknown;
  readonly edges?: unknown;
}

/** 跨 frame 输入：frame 列表或 `{graphs}` 包装（其余视为空）。 */
export type FrameRelationsInput =
  | readonly FrameGraphSourceInput[]
  | { readonly graphs?: unknown }
  | null
  | undefined;

/** 跨 frame 关系构建选项。 */
export interface FrameRelationsOptions {
  readonly limits?: { readonly frames?: unknown; readonly relations?: unknown } | null;
}

/** 归一化后的单帧输入。 */
export interface CollectedFrameGraph {
  frameId: number;
  url: string | null;
  parentFrameId: number | null;
  graph: VomGraphFacts;
}
