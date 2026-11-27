// packages/vom/src/types.ts —— VOM 三个纯函数模块的类型面。
//
// 对应关系：
//   Affordance*  ← extension/src/lib/vom-affordance.js
//   Layer*       ← extension/src/lib/vom-layers.js
//   RowAnchor*   ← extension/src/lib/vom-rows.js
//
// 输入刻意保留为“页面侧事实投影”：字段全部 optional 且运行时可能来自第三方页面库
// 或旧版本 payload，因此用 unknown 接、在实现里显式 String()/Number() 归一。输出则
// 是严格类型，调用方（observe payload / 动作守卫 / 诊断）不再猜字段。

// ---------------------------------------------------------------------------
// affordance
// ---------------------------------------------------------------------------

/** 单节点 affordance 类型。 */
export type AffordanceType =
  | 'activate'
  | 'type'
  | 'toggle'
  | 'select'
  | 'drag'
  | 'scroll'
  | 'dismiss'
  | 'hover'
  | 'focus'
  | 'upload';

/** 无可用 affordance 时的哨兵。 */
export type EmptyAffordanceType = 'none';

/** type 字段的完整取值范围。 */
export type AffordanceKind = AffordanceType | EmptyAffordanceType;

/** evidence 的 value 只可以是可 JSON 化的标量（便于 payload 与回归快照）。 */
export type AffordanceValue = string | number | boolean | null;

/** 单条证据：规则名 + 命中字段 + 字段值。 */
export interface AffordanceEvidence {
  readonly rule: string;
  readonly field: string;
  readonly value: AffordanceValue;
}

/** 备选 affordance（按置信度取前 2）。 */
export interface AffordanceAlternative {
  readonly type: AffordanceType;
  readonly confidence: number;
}

/** affordanceForNode 的返回。 */
export interface AffordanceResult {
  readonly type: AffordanceKind;
  readonly confidence: number;
  readonly evidence: AffordanceEvidence[];
  readonly alternatives: AffordanceAlternative[];
}

/** 节点事实取值：页面侧可能给 string/number/boolean/null，或字段缺失。 */
export type NodeFactValue = string | number | boolean | null | undefined;

/** 祖先链上的最小事实（判是否在 dialog 内）。 */
export interface AncestorFacts {
  readonly role?: NodeFactValue;
  readonly tag?: NodeFactValue;
}

/**
 * 观察节点事实（page-lib formatNode 的字段子集 + 页面侧补充事实）。
 * 兼容字段：inputType/type、contentEditable/contenteditable、overflowY/overflow、
 * tabIndex/tabindex —— 与 JS 实现读取的两套字段名保持一致。
 */
export interface NodeFacts {
  readonly role?: NodeFactValue;
  readonly tag?: NodeFactValue;
  readonly inputType?: NodeFactValue;
  readonly type?: NodeFactValue;
  readonly name?: NodeFactValue;
  readonly contentEditable?: NodeFactValue;
  readonly contenteditable?: NodeFactValue;
  readonly draggable?: NodeFactValue;
  readonly dragHint?: NodeFactValue;
  readonly overflowY?: NodeFactValue;
  readonly overflow?: NodeFactValue;
  readonly scrollable?: NodeFactValue;
  readonly ariaHasPopup?: NodeFactValue;
  readonly hoverable?: NodeFactValue;
  readonly href?: NodeFactValue;
  readonly clickable?: NodeFactValue;
  readonly cursor?: NodeFactValue;
  readonly tabIndex?: NodeFactValue;
  readonly tabindex?: NodeFactValue;
  readonly ariaPressed?: NodeFactValue;
  readonly expanded?: NodeFactValue;
  readonly ancestors?: readonly (AncestorFacts | null | undefined)[] | null;
}

/** affordanceForNode 输入：节点事实或空值。 */
export type AffordanceInput = NodeFacts | null | undefined;

/** summarizeAffordances 的返回。 */
export interface AffordanceSummary {
  readonly version: number;
  readonly total: number;
  readonly byType: Record<string, number>;
}

// ---------------------------------------------------------------------------
// layers
// ---------------------------------------------------------------------------

/** 层种类（后 → 前）：文档基底 → 固定/粘性 → 浮动 → 阻挡 → 顶层。 */
export type LayerKind = 'base' | 'fixed-sticky' | 'floating' | 'blocking' | 'top-layer';

/** 归一化后的 DIP 矩形（整数像素）。 */
export interface LayerRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** 原始矩形事实：兼容 width/height 与 w/h 两套字段名。 */
export interface LayerRectInput {
  readonly x?: unknown;
  readonly y?: unknown;
  readonly width?: unknown;
  readonly height?: unknown;
  readonly w?: unknown;
  readonly h?: unknown;
}

/** 计算样式投影（只取本模块用到的两个键，其余原样透传）。 */
export interface LayerStyleFacts {
  readonly position?: unknown;
  readonly 'z-index'?: unknown;
  readonly [key: string]: unknown;
}

/**
 * 单个层事实：兼容阻塞层既有输出（computeBlockingLayers）、页面侧
 * layerStackFacts 与更原始的 DOM 事实对象。
 */
export interface LayerFact {
  readonly rect?: LayerRectInput | null;
  readonly bounds?: LayerRectInput | null;
  readonly role?: unknown;
  readonly layerKind?: unknown;
  readonly kind?: unknown;
  readonly position?: unknown;
  readonly zIndex?: unknown;
  readonly topLayer?: unknown;
  readonly coverage?: unknown;
  readonly blocking?: unknown;
  readonly level?: unknown;
  readonly name?: unknown;
  readonly id?: unknown;
  readonly tag?: unknown;
  readonly backendNodeId?: unknown;
  readonly pointerEvents?: unknown;
  readonly paintOrder?: unknown;
  readonly styles?: LayerStyleFacts | null;
}

/** normalizeLayer 的输出（尚未排定绘制顺序，因此没有 index）。 */
export interface LayerCandidate {
  readonly kind: LayerKind;
  readonly zIndex: number | null;
  readonly blocking: boolean;
  readonly rect: LayerRect | null;
  readonly level: string;
  readonly role: string | null;
  readonly name: string | null;
  readonly id: string | null;
  readonly tag: string | null;
  readonly backendNodeId: number | null;
  readonly coverage: number | null;
  readonly position: string | null;
  readonly topLayer: string | null;
  readonly pointerEvents: string | null;
  readonly paintOrder: number;
  readonly sourceIndex: number;
}

/** 有序层模型里的一层：candidate + 绘制顺序。 */
export interface Layer extends LayerCandidate {
  readonly index: number;
}

/** 层数量统计。 */
export interface LayerCounts {
  readonly total: number;
  readonly byKind: Partial<Record<LayerKind, number>>;
}

/** deriveLayers 的返回。 */
export interface LayerModel {
  readonly version: number;
  readonly layers: Layer[];
  readonly counts: LayerCounts;
  readonly truncated: boolean;
}

/** deriveLayers 输入：层事实数组或 {layers} 包装（阻塞层既有输出）。 */
export type LayerInput =
  | readonly LayerFact[]
  | { readonly layers?: readonly LayerFact[] | null }
  | null
  | undefined;

/** deriveLayers 选项。 */
export interface DeriveLayersOptions {
  /** 是否插入文档基底层（默认 true）。 */
  readonly includeBase?: boolean;
  /** 结果层数上限（1..100，默认 24）。 */
  readonly limit?: number;
}

// ---------------------------------------------------------------------------
// rows
// ---------------------------------------------------------------------------

/** 页面侧 anchor 契约对象：七个主字段 + 两个辅助字段（role/tag）。 */
export interface RowAnchor {
  ariaRowIndex: number | null;
  dataIndex: number | null;
  transform: string | null;
  rowKey: string | null;
  rowText: string | null;
  containerScrollTop: number | null;
  recycled: boolean;
  /** 辅助字段：classifyVirtualRow 判行/格类型用，不参与稳定性比较。 */
  role?: string;
  tag?: string;
}

/** 原始 anchor 事实：兼容旧字段名 aria-rowindex / data-index / text。 */
export interface RowAnchorRaw {
  readonly ariaRowIndex?: unknown;
  readonly 'aria-rowindex'?: unknown;
  readonly dataIndex?: unknown;
  readonly 'data-index'?: unknown;
  readonly transform?: unknown;
  readonly rowKey?: unknown;
  readonly rowText?: unknown;
  readonly text?: unknown;
  readonly containerScrollTop?: unknown;
  readonly recycled?: unknown;
  readonly role?: unknown;
  readonly tag?: unknown;
}

/** normalizeRowAnchor 输入。 */
export type RowAnchorInput = RowAnchorRaw | RowAnchor | null | undefined;

/** 节点上的 row 事实投影（anchors 可能在 anchor 或 rowAnchor 字段）。 */
export interface RowNodeFacts {
  readonly anchor?: RowAnchorRaw | null;
  readonly rowAnchor?: RowAnchorRaw | null;
}

/** summarizeRowAnchors 的返回。 */
export interface RowAnchorSummary {
  readonly version: number;
  readonly total: number;
  readonly anchored: number;
  readonly recycled: number;
  readonly withRowKey: number;
  readonly withIndex: number;
  readonly transformed: number;
  readonly containers: number;
  readonly byRole: Record<string, number>;
}
