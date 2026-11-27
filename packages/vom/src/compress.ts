// packages/vom/src/compress.ts —— 语义压缩：按 VOM 分组/关系折叠同类条目并输出 compression 报告。
//
// 源：extension/src/lib/vom-compress.js（行为逐字段等价的基线，差分测试对拍）。
//
// 目的：大页面里同一组（landmark/form/table）或同一 "owner → 多个 option" 关系会重复出现
// 几十条同形条目。Agent 需要的是“这个组里有 18 个选项，样例是 A/B/C”，而不是 18 行。
// 本模块做两件事：
//   1) 组折叠：把一个组里的成员节点合并成一条 summary 条目（计数 + 样例 + 角色直方图 + token 节省）；
//   2) 关系折叠：同一 (type, from) 下重复的目标合并成一条带 count 的折叠关系。
// 输出带 report（before/after nodes/tokens、ratio、folds、byKind），供 observe 与诊断直接读。
//
// 计费口径与 tokens.estimateVomTokens 完全一致（只按 name+role），压缩不改变计费模型：
// summary 条目按自身的 name+role 计费，report 里的 tokensSaved 是“折叠前 - 折叠后”的差。

import { estimateVomTokens } from './tokens.ts';
import type { VomTokenNodeFacts } from './tokens.ts';
import type {
  CompressContextGroupFact,
  CompressLegacyGroupFact,
  CompressRelationFact,
  CompressSemanticNodeFact,
  VomCompressInput,
  VomCompressNode,
  VomCompressOptions,
  VomCompressionFold,
  VomCompressionReport,
  VomCompressionResult,
  VomRelationFold,
} from './compress-types.ts';

/** 语义压缩报告版本。 */
export const VOM_COMPRESSION_VERSION = 1;

/** 压缩默认上限。 */
export const COMPRESSION_LIMITS: Readonly<{
  folds: number;
  sampleNames: number;
  relationFolds: number;
  relationFoldMin: number;
  relationTos: number;
}> = Object.freeze({
  folds: 24,
  sampleNames: 3,
  relationFolds: 16,
  relationFoldMin: 3,
  relationTos: 4,
});

/** 组 kind 的折叠顺序（越靠前越先折叠）。 */
const KIND_ORDER: Readonly<Record<string, number>> = Object.freeze({
  table: 0, form: 1, landmark: 2, section: 3, row: 4,
});

/** 上限归一：非有限/非正回落到 fallback，向下取整后夹到 max。 */
function limitOf(value: unknown, fallback: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.floor(number), max);
}

/** 数组归一（只接受真数组）。 */
function arrayOf<T>(value: unknown): readonly T[] {
  return Array.isArray(value) ? (value as readonly T[]) : [];
}

/** 节点文本（折叠样例名）；null/undefined → ''。 */
function textOf(node: VomCompressNode | null | undefined): string {
  if (!node) return '';
  return String(node.name != null ? node.name : '');
}

/** 折叠单元（来自 context.groups / groups.sections|rows|forms / semantic.nodes 三种形态）。 */
interface GroupUnit {
  id: string;
  /** 组 kind：保留原始值（页面侧可能给非字符串），参与排序与 byKind 键。 */
  kind: string;
  groupKind: string | null;
  name: string | null;
  role: string | null;
  memberIds: string[];
  tokens: number;
  source: 'context' | 'groups' | 'semantic';
}

/** 按优先级取分组来源：context.groups → 旧 groups → semantic.nodes；空则换下一个。 */
function groupUnits(input: VomCompressInput): GroupUnit[] {
  const units: GroupUnit[] = [];
  const context = input.context && typeof input.context === 'object'
    ? (input.context as { readonly groups?: unknown })
    : null;
  if (context && Array.isArray(context.groups)) {
    for (const group of arrayOf<CompressContextGroupFact>(context.groups)) {
      if (!group || !Array.isArray(group.memberIds)) continue;
      units.push({
        id: String(group.id),
        kind: (group.kind || group.groupKind || 'group') as string,
        groupKind: (group.groupKind || null) as string | null,
        name: (group.name || null) as string | null,
        role: (group.role || null) as string | null,
        memberIds: (group.memberIds as readonly unknown[]).map(String),
        tokens: Number(group.tokens) || 0,
        source: 'context',
      });
    }
  }
  if (!units.length && input.groups && typeof input.groups === 'object') {
    const groups = input.groups as Record<string, unknown>;
    for (const kind of ['sections', 'rows', 'forms']) {
      for (const group of arrayOf<CompressLegacyGroupFact>(groups[kind])) {
        if (!group || !Array.isArray(group.nodeIds)) continue;
        units.push({
          id: 'g:' + kind + ':' + String(group.id),
          kind: kind === 'sections' ? 'landmark' : (kind === 'rows' ? 'row' : 'form'),
          groupKind: kind === 'sections' ? 'section' : (kind === 'rows' ? 'row' : 'form'),
          name: group.anchor && group.anchor.id ? '#' + String(group.anchor.id) : null,
          role: group.anchor && group.anchor.role ? String(group.anchor.role) : null,
          memberIds: (group.nodeIds as readonly unknown[]).map(String),
          tokens: Number(group.tokens) || 0,
          source: 'groups',
        });
      }
    }
  }
  if (!units.length && input.semantic && typeof input.semantic === 'object') {
    const semantic = input.semantic as { readonly nodes?: unknown };
    for (const node of arrayOf<CompressSemanticNodeFact>(semantic.nodes)) {
      if (!node || !Array.isArray(node.memberIds)) continue;
      units.push({
        id: String(node.id),
        kind: (node.groupKind || 'group') as string,
        groupKind: (node.groupKind || null) as string | null,
        name: null,
        role: null,
        memberIds: (node.memberIds as readonly unknown[]).map(String),
        tokens: Number(node.tokens) || 0,
        source: 'semantic',
      });
    }
  }
  units.sort((a, b) => {
    const left = KIND_ORDER[a.kind] != null ? KIND_ORDER[a.kind] : 9;
    const right = KIND_ORDER[b.kind] != null ? KIND_ORDER[b.kind] : 9;
    if (left !== right) return (left ?? 9) - (right ?? 9);
    return b.memberIds.length - a.memberIds.length;
  });
  return units;
}

/** 关系入参归一：数组或 {relations} 包装；其余为空。 */
function relationListOf(relations: unknown): readonly CompressRelationFact[] {
  if (Array.isArray(relations)) return relations as readonly CompressRelationFact[];
  if (relations && typeof relations === 'object') {
    const wrapped = (relations as { readonly relations?: unknown }).relations;
    if (Array.isArray(wrapped)) return wrapped as readonly CompressRelationFact[];
  }
  return [];
}

/** 同一 (type, from) 下重复关系折叠成一条带 count 的摘要。 */
function foldRelations(
  relations: readonly CompressRelationFact[],
  options: VomCompressOptions,
): { folds: VomRelationFold[]; foldedRelations: number; total: number } {
  const minCount = limitOf(options.relationFoldMin, COMPRESSION_LIMITS.relationFoldMin, 100);
  const maxFolds = limitOf(options.relationFolds, COMPRESSION_LIMITS.relationFolds, 500);
  const maxTos = limitOf(options.relationTos, COMPRESSION_LIMITS.relationTos, 64);
  const buckets = new Map<string, {
    type: string;
    from: string;
    count: number;
    confidenceSum: number;
    targets: string[];
    sources: Set<unknown>;
  }>();
  for (const relation of relations) {
    if (!relation || !relation.type || relation.from == null) continue;
    const key = String(relation.type) + '\u0000' + String(relation.from);
    const bucket = buckets.get(key) || {
      type: relation.type as string,
      from: String(relation.from),
      count: 0,
      confidenceSum: 0,
      targets: [],
      sources: new Set<unknown>(),
    };
    bucket.count += 1;
    bucket.confidenceSum += Number(relation.confidence) || 0;
    if (bucket.targets.length < maxTos) bucket.targets.push(String(relation.to));
    for (const source of Array.isArray(relation.sources) ? relation.sources : [relation.source]) {
      if (source) bucket.sources.add(source);
    }
    buckets.set(key, bucket);
  }
  const folds: VomRelationFold[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.count < minCount) continue;
    folds.push({
      type: bucket.type,
      from: bucket.from,
      count: bucket.count,
      targets: bucket.targets.slice(),
      sources: [...bucket.sources] as string[],
      averageConfidence: Math.round((bucket.confidenceSum / bucket.count) * 1000) / 1000,
    });
  }
  folds.sort((a, b) => b.count - a.count);
  const kept = folds.slice(0, maxFolds);
  return { folds: kept, foldedRelations: kept.reduce((sum, fold) => sum + fold.count, 0), total: folds.length };
}

/**
 * 按分组/关系折叠 VOM 节点。
 *
 * 语义：
 * - 组成员先到先折，已折叠节点不再被后面的组重复折叠（foldedIds）；
 * - 单组成员数 < minMembers 不折叠（少成员折叠没有收益）；
 * - summary 条目自身也按 name+role 计费，report.saved.tokens 是“折叠前 - 折叠后”的差；
 * - includeRelationFolds=false 时只看组折叠，关系折叠三项计数为 0。
 */
export function compressVomByRelations(
  input: VomCompressInput = {},
  options: VomCompressOptions = {},
): VomCompressionResult {
  const nodes = Array.isArray(input.nodes)
    ? (input.nodes as readonly VomCompressNode[]).filter((node) => node && node.id != null)
    : [];
  const maxFolds = limitOf(options.maxFolds, COMPRESSION_LIMITS.folds, 200);
  const sampleNames = limitOf(options.sampleNames, COMPRESSION_LIMITS.sampleNames, 12);
  const minMembers = limitOf(options.minMembers, 2, 100);
  const nodeById = new Map<string, VomCompressNode>();
  for (const node of nodes) nodeById.set(String(node.id), node);
  const beforeTokens = nodes.reduce((sum, node) => sum + estimateVomTokens(node as VomTokenNodeFacts), 0);
  const units = groupUnits(input);
  const foldedIds = new Set<string>();
  const folded: VomCompressionFold[] = [];
  const byKind: Record<string, number> = {};
  for (const unit of units) {
    if (folded.length >= maxFolds) break;
    const members = unit.memberIds.filter((id) => nodeById.has(id) && !foldedIds.has(id));
    if (members.length < minMembers) continue;
    const memberNodes = members.map((id) => nodeById.get(id) as VomCompressNode);
    const tokensBefore = memberNodes.reduce((sum, node) => sum + estimateVomTokens(node as VomTokenNodeFacts), 0);
    const roles: Record<string, number> = {};
    for (const node of memberNodes) {
      const role = String(node.role || 'generic').toLowerCase();
      roles[role] = (roles[role] || 0) + 1;
    }
    const sample = memberNodes
      .map((node) => textOf(node))
      .filter(Boolean)
      .slice(0, sampleNames);
    const label = unit.name ? String(unit.name) : (unit.groupKind || unit.kind);
    const summary: VomCompressionFold = {
      id: 'fold:' + unit.id,
      kind: 'fold',
      groupKind: unit.groupKind || unit.kind,
      role: 'group',
      name: label + ' ×' + members.length,
      count: members.length,
      sampleNames: sample,
      memberIds: members.slice(),
      roles,
      tokensBefore,
      tokens: 0,
      tokensSaved: 0,
      ratio: 1,
    };
    summary.tokens = estimateVomTokens(summary as VomTokenNodeFacts);
    const ratio = tokensBefore > 0 ? summary.tokens / tokensBefore : 1;
    summary.tokensSaved = Math.max(0, tokensBefore - summary.tokens);
    summary.ratio = Math.round(ratio * 1000) / 1000;
    for (const id of members) foldedIds.add(id);
    folded.push(summary);
    byKind[unit.kind] = (byKind[unit.kind] || 0) + 1;
  }
  const kept: VomCompressNode[] = [];
  for (const node of nodes) if (!foldedIds.has(String(node.id))) kept.push(node);
  const afterTokens = kept.reduce((sum, node) => sum + estimateVomTokens(node as VomTokenNodeFacts), 0)
    + folded.reduce((sum, fold) => sum + fold.tokens, 0);
  const relations = relationListOf(input.relations);
  const relationFoldResult = options.includeRelationFolds === false
    ? { folds: [] as VomRelationFold[], foldedRelations: 0, total: 0 }
    : foldRelations(relations, options);
  const foldedTokens = folded.reduce((sum, fold) => sum + fold.tokensSaved, 0);
  const report: VomCompressionReport = {
    before: { nodes: nodes.length, tokens: beforeTokens },
    after: { nodes: kept.length + folded.length, tokens: afterTokens },
    saved: {
      nodes: folded.reduce((sum, fold) => sum + (fold.count - 1), 0),
      tokens: Math.max(0, beforeTokens - afterTokens),
      ratio: beforeTokens > 0 ? Math.round(((beforeTokens - afterTokens) / beforeTokens) * 1000) / 1000 : 0,
    },
    folds: folded.length,
    foldedMembers: folded.reduce((sum, fold) => sum + fold.count, 0),
    foldedTokens,
    byKind,
    relations: relations.length,
    relationFolds: relationFoldResult.folds.length,
    foldedRelations: relationFoldResult.foldedRelations,
  };
  return {
    version: VOM_COMPRESSION_VERSION,
    nodes: kept,
    folded,
    relationFolds: relationFoldResult.folds,
    report,
  };
}

/** 语义压缩报告的一行摘要。 */
export function summarizeVomCompression(report: unknown): string {
  const wrapper = report && typeof report === 'object' && 'report' in (report as object)
    ? (report as { readonly report?: unknown })
    : null;
  const value = (wrapper && wrapper.report ? wrapper.report : report) as {
    readonly before?: { readonly nodes?: unknown; readonly tokens?: unknown } | null;
    readonly after?: { readonly nodes?: unknown; readonly tokens?: unknown } | null;
    readonly saved?: { readonly tokens?: unknown; readonly ratio?: unknown } | null;
    readonly folds?: unknown;
    readonly foldedMembers?: unknown;
    readonly relationFolds?: unknown;
  } | null | undefined;
  if (!value || !value.before) return 'compression: n/a';
  const after = value.after || {};
  const saved = value.saved || {};
  const parts = [
    'nodes ' + String(value.before.nodes) + '→' + String(after.nodes),
    'tokens ' + String(value.before.tokens) + '→' + String(after.tokens),
    'saved=' + String(saved.tokens) + ' (' + Math.round((Number(saved.ratio) || 0) * 100) + '%)',
    'folds=' + String(value.folds),
    'members=' + String(value.foldedMembers),
    'relation-folds=' + String(value.relationFolds),
  ];
  return parts.join(' ');
}
