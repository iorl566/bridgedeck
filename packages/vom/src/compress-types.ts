// packages/vom/src/compress-types.ts —— 语义压缩（组折叠/关系折叠）的类型面。
//
// 对应实现：src/compress.ts（按 VOM 分组/关系折叠同类条目并输出 compression 报告）。

/** 可被折叠的节点：只要求 id 存在，其余字段原样透传。 */
export interface VomCompressNode {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly role?: unknown;
  readonly [extra: string]: unknown;
}

/** 一个被折叠出来的摘要条目（成员节点被它取代）。 */
export interface VomCompressionFold {
  id: string;
  kind: 'fold';
  groupKind: string;
  role: 'group';
  name: string;
  count: number;
  sampleNames: string[];
  memberIds: string[];
  roles: Record<string, number>;
  tokensBefore: number;
  tokens: number;
  tokensSaved: number;
  ratio: number;
}

/** 关系折叠：同一 (type, from) 下重复目标合并成一条。 */
export interface VomRelationFold {
  type: string;
  from: string;
  count: number;
  targets: string[];
  sources: string[];
  averageConfidence: number;
}

/** 压缩报告（before/after、节省量、折叠计数）。 */
export interface VomCompressionReport {
  before: { nodes: number; tokens: number };
  after: { nodes: number; tokens: number };
  saved: { nodes: number; tokens: number; ratio: number };
  folds: number;
  foldedMembers: number;
  foldedTokens: number;
  byKind: Record<string, number>;
  relations: number;
  relationFolds: number;
  foldedRelations: number;
}

/** compressVomByRelations 的返回。 */
export interface VomCompressionResult {
  version: number;
  nodes: VomCompressNode[];
  folded: VomCompressionFold[];
  relationFolds: VomRelationFold[];
  report: VomCompressionReport;
}

/** 压缩输入：节点 + 组/上下文/关系来源（三者任一提供分组即可）。 */
export interface VomCompressInput {
  readonly nodes?: unknown;
  readonly relations?: unknown;
  readonly context?: unknown;
  readonly groups?: unknown;
  readonly semantic?: unknown;
}

/** 压缩选项。 */
export interface VomCompressOptions {
  readonly maxFolds?: unknown;
  readonly sampleNames?: unknown;
  readonly minMembers?: unknown;
  readonly includeRelationFolds?: boolean;
  readonly relationFoldMin?: unknown;
  readonly relationFolds?: unknown;
  readonly relationTos?: unknown;
}

/** 上下文组事实（context.groups 项）。 */
export interface CompressContextGroupFact {
  readonly id?: unknown;
  readonly kind?: unknown;
  readonly groupKind?: unknown;
  readonly name?: unknown;
  readonly role?: unknown;
  readonly memberIds?: unknown;
  readonly tokens?: unknown;
}

/** 旧组事实（groups.sections/rows/forms 项）。 */
export interface CompressLegacyGroupFact {
  readonly id?: unknown;
  readonly nodeIds?: unknown;
  readonly anchor?: { readonly id?: unknown; readonly role?: unknown } | null;
  readonly tokens?: unknown;
}

/** 语义组图节点事实。 */
export interface CompressSemanticNodeFact {
  readonly id?: unknown;
  readonly groupKind?: unknown;
  readonly memberIds?: unknown;
  readonly tokens?: unknown;
}

/** 关系事实（关系折叠用）。 */
export interface CompressRelationFact {
  readonly type?: unknown;
  readonly from?: unknown;
  readonly to?: unknown;
  readonly confidence?: unknown;
  readonly source?: unknown;
  readonly sources?: unknown;
}
