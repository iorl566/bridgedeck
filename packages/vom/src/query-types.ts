// packages/vom/src/query-types.ts —— 关系图查询的类型面（过滤/分页/摘要）。
//
// 对应实现：src/query.ts（按 kind/role/name 过滤 + 分页 + 摘要的纯函数）。

/** 排序键：插入顺序 / 置信度 / 类型 / 名字 / 来源。 */
export type RelationQuerySort = 'insertion' | 'confidence' | 'type' | 'name' | 'source';

/** 方向过滤。 */
export type RelationQueryDirection = 'both' | 'out' | 'in';

/** 归一化后的查询参数（大小写不敏感；未知键忽略，不抛错）。 */
export interface NormalizedRelationQuery {
  types: string[];
  sources: string[];
  roles: string[];
  names: string[];
  minConfidence: number | null;
  maxConfidence: number | null;
  from: string | null;
  to: string | null;
  direction: RelationQueryDirection;
  self: boolean | null;
  crossFrame: boolean;
  sort: RelationQuerySort;
  offset: number;
  limit: number;
}

/** 查询结果里的一条关系（公开视图）。 */
export interface QueryRelationItem {
  type: string;
  from: string;
  to: string;
  confidence: number;
  source: string | null;
  sources: string[];
  fromRole: string | null;
  toRole: string | null;
  fromName: string | null;
  toName: string | null;
  self?: true;
  text?: string;
  frame?: true;
  depth?: number;
  chain?: string[];
}

/** 分页信息。 */
export interface RelationQueryPage {
  offset: number;
  limit: number;
  total: number;
  returned: number;
  hasMore: boolean;
  nextOffset: number | null;
}

/** 置信度分桶。 */
export interface RelationQueryBuckets {
  high: number;
  medium: number;
  low: number;
}

/** 查询摘要（针对全部命中项，不只是当前页）。 */
export interface RelationQuerySummary {
  total: number;
  returned: number;
  byType: Record<string, number>;
  bySource: Record<string, number>;
  byRole: Record<string, number>;
  confidenceBuckets: RelationQueryBuckets;
  averageConfidence: number;
  self: number;
  crossFrame: number;
  kinds: string[];
}

/** queryVomRelations 的返回。 */
export interface VomRelationQueryResult {
  version: number;
  query: NormalizedRelationQuery;
  items: QueryRelationItem[];
  page: RelationQueryPage;
  summary: RelationQuerySummary;
}

/** 关系图输入项（关系记录或任意兼容事实）。 */
export interface VomRelationQueryFact {
  readonly type?: unknown;
  readonly from?: unknown;
  readonly to?: unknown;
  readonly confidence?: unknown;
  readonly source?: unknown;
  readonly sources?: unknown;
  readonly fromRole?: unknown;
  readonly toRole?: unknown;
  readonly fromName?: unknown;
  readonly toName?: unknown;
  readonly self?: unknown;
  readonly text?: unknown;
  readonly frame?: unknown;
  readonly depth?: unknown;
  readonly chain?: unknown;
}

/** 端点节点池项（角色/名字来源）。 */
export interface VomQueryNodeFacts {
  readonly id?: unknown;
  readonly role?: unknown;
  readonly name?: unknown;
}

/** 关系图输入：关系数组或 {relations, nodes} 图对象。 */
export type VomRelationQueryGraph =
  | readonly VomRelationQueryFact[]
  | {
    readonly relations?: readonly VomRelationQueryFact[];
    readonly nodes?: readonly VomQueryNodeFacts[];
  };

/** 分页默认值与上限。 */
export interface RelationQueryDefaults {
  readonly limit: number;
  readonly maxLimit: number;
  readonly maxOffset: number;
}

/** summarizeRelationQuery 可接受的输入。 */
export interface RelationQuerySummarySource {
  readonly page?: Partial<RelationQueryPage> | null;
  readonly summary?: Partial<RelationQuerySummary> | null;
}
