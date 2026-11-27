// src/content/vom-summary.ts —— observe 的 VOM 摘要：唯一消费点 packages/vom。
//
// 为什么需要这一层：
// - W7-E 之前 `apps/extension/src/content/rich.ts` 自己拼 VOM 摘要（nodes/edges/stages/
//   semantic 都是页面侧临时逻辑），与 `extension/src/lib/vom-*.js` 是两套实现；
// - 现在 VOM 的 affordance / relations / context 全部由 `packages/vom` 计算（单一实现），
//   本模块只做三件事：调用顺序、结果聚合（groups/stats）、以及自检（verifyVomSummary）；
// - 与 JS 版逐字段等价由 `tests/vom-diff.test.ts` 用同一组 facts JSON 对拍证明，不靠“差不多”。
//
// 输出边界（如实标注）：
// - 摘要只覆盖 affordance / relations / context / groups；六阶段评分、vomScore、计费账本、
//   预算裁剪仍不在本层（vomScore 由 rich.ts 的启发式给出，字段名保持既有契约）；
// - facts 只来自本帧 DOM（无 CDP），跨 frame 汇总需要调用方提供 frames 子图，TS background
//   尚未聚合（见 D 报告与 limitations）。
//
// 调用链：rich.ts（observe --vom）→ buildVomPageFacts → buildVomSummary → 回包字段。

import {
  AFFORDANCE_TYPES,
  AFFORDANCE_VERSION,
  RELATION_KINDS,
  VOM_CONTEXT_VERSION,
  VOM_RELATIONS_VERSION,
  affordanceForNode,
  buildVomContext,
  buildVomRelationGraph,
  summarizeAffordances,
} from '../../../../packages/vom/src/index.ts';
import type {
  AffordanceResult,
  AffordanceSummary,
  BuildVomContextInput,
  VomContextGroup,
  VomContextModel,
  VomRelationGraph,
} from '../../../../packages/vom/src/index.ts';
import {
  VOM_FACTS_LIMITATIONS,
  affordanceInputOf,
  contextInputOf,
  projectVomFacts,
  relationInputOf,
  type VomFactsProjection,
  type VomPageFacts,
} from './vom-facts.ts';

/** 摘要结构版本：字段增删时递增。 */
export const VOM_SUMMARY_VERSION = 1;

/** groups 摘要里最多列出多少个组（完整组列表在 context.groups 里，受 facts limits 约束）。 */
export const VOM_GROUP_DIGEST_LIMIT = 64;

/** 单节点的 affordance 视图（observe 节点与摘要共用同一份判定）。 */
export interface VomNodeAffordance {
  id: string;
  ref: string | null;
  role: string;
  name: string;
  affordance: AffordanceResult;
}

/** 组摘要：packages/vom context 的分组结果（landmark/form/table）压缩成可快速消费的清单。 */
export interface VomGroupDigest {
  id: string;
  kind: string;
  groupKind: string;
  anchorId: string;
  role: string | null;
  tag: string | null;
  name: string | null;
  members: number;
  depth: number;
  parentId: string | null;
  frameId: number | null;
}

/** groups 摘要（计数 + 前 N 个组；总数不因摘要截断而撒谎）。 */
export interface VomGroupsSummary {
  version: 1;
  source: 'packages/vom.context';
  total: number;
  shown: number;
  byKind: Record<string, number>;
  byGroupKind: Record<string, number>;
  parented: number;
  framed: number;
  tableHeaders: number;
  truncated: boolean;
  groups: VomGroupDigest[];
}

/** 摘要统计（全部由 packages/vom 的输出派生，不另行判定）。 */
export interface VomSummaryStats {
  nodes: number;
  entries: number;
  edges: number;
  frames: number;
  relations: number;
  byRelationType: Record<string, number>;
  byRelationSource: Record<string, number>;
  lowConfidence: number;
  averageConfidence: number;
  relationGroups: number;
  contexts: number;
  contextGroups: number;
  byContextKind: Record<string, number>;
  parentedGroups: number;
  framedContexts: number;
  tableHeaders: number;
  affordanceTotal: number;
  byAffordanceType: Record<string, number>;
  truncated: {
    facts: boolean;
    graph: boolean;
    relations: boolean;
    contexts: boolean;
  };
}

/** 页面图边的结构化视图（observe `vom.edges` 用；与 packages/vom GraphEdgeType 同构）。 */
export interface VomSummaryEdge {
  type: string;
  from: string;
  to: string;
}

/** observe 的 VOM 摘要（rich.ts 把它展开成 `vom` / `relations` / `context` / `groups`）。 */
export interface VomUnifiedSummary {
  version: 1;
  source: 'packages/vom';
  versions: {
    facts: number;
    affordance: number;
    relations: number;
    context: number;
  };
  nodes: VomNodeAffordance[];
  affordance: AffordanceSummary;
  edges: VomSummaryEdge[];
  /**
   * 关系端点全集：本帧节点 + 页面图节点（含 frame:<id>）+ frame 子图节点。
   * 关系图允许跨 frame 端点（如 f5:btn），因此自检不能只看本帧 nodes。
   */
  knownNodeIds: string[];
  relations: VomRelationGraph;
  context: VomContextModel;
  groups: VomGroupsSummary;
  stats: VomSummaryStats;
  limitations: string[];
}

/** 摘要的固定限制说明（与 facts 限制合并去重后输出）。 */
export const VOM_SUMMARY_LIMITATIONS: readonly string[] = Object.freeze([
  'VOM 的 affordance/relations/context/groups 由 packages/vom 计算（单一实现，JS 差分见 tests/vom-diff.test.ts）',
  '摘要不含六阶段评分/计费账本/预算裁剪：vomScore 仍是 rich.ts 的启发式分数',
  'relations/context 的上限来自 facts.limits（默认 600 关系 / 200 组），截断在 stats.truncated 如实标记',
]);

function uniqueStrings(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (!value || out.includes(value)) continue;
    out.push(value);
  }
  return out;
}

function digestGroup(group: VomContextGroup): VomGroupDigest {
  return {
    id: group.id,
    kind: group.kind,
    groupKind: group.groupKind,
    anchorId: group.anchorId,
    role: group.role,
    tag: group.tag,
    name: group.name,
    members: group.members,
    depth: group.depth,
    parentId: group.parentId,
    frameId: group.frameId,
  };
}

/** context 组 → groups 摘要（按成员数降序，同数按 id 保证确定性）。 */
export function summarizeVomGroups(context: VomContextModel | null | undefined): VomGroupsSummary {
  const groups = context && Array.isArray(context.groups) ? context.groups : [];
  const ordered = groups
    .slice()
    .sort((left, right) => (right.members - left.members) || left.id.localeCompare(right.id));
  const shown = ordered.slice(0, VOM_GROUP_DIGEST_LIMIT).map(digestGroup);
  const stats = context ? context.stats : null;
  return {
    version: 1,
    source: 'packages/vom.context',
    total: groups.length,
    shown: shown.length,
    byKind: { ...(stats ? stats.byKind : {}) },
    byGroupKind: { ...(stats ? stats.byGroupKind : {}) },
    parented: stats ? stats.parented : groups.filter((group) => group.parentId != null).length,
    framed: stats ? stats.framed : 0,
    tableHeaders: stats ? stats.tableHeaders : 0,
    truncated: Boolean(stats && stats.truncated) || shown.length < groups.length,
    groups: shown,
  };
}

/** 按节点顺序计算 affordance（节点视图 + 汇总一次算完，避免同一节点判两次出现分歧）。 */
export function collectNodeAffordances(
  facts: VomPageFacts,
): { nodes: VomNodeAffordance[]; summary: AffordanceSummary } {
  const nodes: VomNodeAffordance[] = [];
  const inputs: unknown[] = [];
  for (const node of Array.isArray(facts.nodes) ? facts.nodes : []) {
    if (!node || !node.id) continue;
    const input = affordanceInputOf(node);
    inputs.push(input);
    nodes.push({
      id: String(node.id),
      ref: node.ref ?? null,
      role: String(node.role || ''),
      name: String(node.name || ''),
      affordance: affordanceForNode(input),
    });
  }
  const summary = summarizeAffordances(inputs);
  return { nodes, summary };
}

/**
 * 构建 observe 的 VOM 摘要（纯函数；输入是 facts JSON，不读 DOM）。
 *
 * 调用顺序与 JS `buildVomPayload` 一致：entries/graph 投影 → relations → context →
 * groups 聚合。relations 的 frames 若存在，context 复用 relations.frames（frame 节点
 * 已按关系图规范化），避免两处 frame 事实不一致。
 */
export function buildVomSummary(facts: VomPageFacts): VomUnifiedSummary {
  const projection: VomFactsProjection = projectVomFacts(facts);
  const affordance = collectNodeAffordances(facts);
  const relations = buildVomRelationGraph(relationInputOf(projection));
  const contextFrames = projection.frames && relations.frames.length
    ? (relations.frames as unknown as BuildVomContextInput['frames'])
    : undefined;
  const context = buildVomContext(contextInputOf(projection, contextFrames));
  const groups = summarizeVomGroups(context);
  const edges = Array.isArray(projection.graph.edges) ? projection.graph.edges.length : 0;
  const graphEdges: VomSummaryEdge[] = (Array.isArray(projection.graph.edges) ? projection.graph.edges : [])
    .map((edge) => ({ type: String(edge.type ?? ''), from: String(edge.from ?? ''), to: String(edge.to ?? '') }))
    .filter((edge) => edge.type.length > 0 && edge.from.length > 0 && edge.to.length > 0);
  const stats: VomSummaryStats = {
    nodes: Array.isArray(facts.nodes) ? facts.nodes.length : 0,
    entries: projection.entries.length,
    edges,
    frames: relations.frames.length,
    relations: relations.stats.relations,
    byRelationType: { ...relations.stats.byType },
    byRelationSource: { ...relations.stats.bySource },
    lowConfidence: relations.stats.lowConfidence,
    averageConfidence: relations.stats.averageConfidence,
    relationGroups: relations.stats.groups,
    contexts: context.stats.contexts,
    contextGroups: context.stats.groups,
    byContextKind: { ...context.stats.byKind },
    parentedGroups: context.stats.parented,
    framedContexts: context.stats.framed,
    tableHeaders: context.stats.tableHeaders,
    affordanceTotal: affordance.summary.total,
    byAffordanceType: { ...affordance.summary.byType },
    truncated: {
      facts: facts.truncated === true,
      graph: projection.graph.truncated === true,
      relations: relations.stats.truncated,
      contexts: context.stats.truncated,
    },
  };
  const limitations = uniqueStrings([...VOM_FACTS_LIMITATIONS, ...VOM_SUMMARY_LIMITATIONS]);
  return {
    version: VOM_SUMMARY_VERSION,
    source: 'packages/vom',
    versions: {
      facts: facts.version,
      affordance: AFFORDANCE_VERSION,
      relations: VOM_RELATIONS_VERSION,
      context: VOM_CONTEXT_VERSION,
    },
    nodes: affordance.nodes,
    affordance: affordance.summary,
    edges: graphEdges,
    knownNodeIds: collectKnownNodeIds(facts, projection),
    relations,
    context,
    groups,
    stats,
    limitations,
  };
}

/** 关系端点全集：本帧节点 + 页面图节点 + 各 frame 子图节点（跨 frame 关系端点可能只在子图）。 */
export function collectKnownNodeIds(facts: VomPageFacts, projection: VomFactsProjection): string[] {
  const ids = new Set<string>();
  for (const node of facts.nodes) if (node && node.id) ids.add(String(node.id));
  const graphNodes = Array.isArray(projection.graph.nodes) ? projection.graph.nodes : [];
  for (const node of graphNodes) if (node && node.id != null) ids.add(String(node.id));
  for (const frame of projection.frames ?? []) {
    const graph = frame.graph ?? null;
    const frameNodes = graph && Array.isArray(graph.nodes) ? graph.nodes : [];
    for (const node of frameNodes) if (node && node.id != null) ids.add(String(node.id));
    if (frame.frameId != null) ids.add('frame:' + String(frame.frameId));
  }
  return [...ids].sort();
}

/** 只取节点 id 集合（关系端点自检/测试用）。 */
function nodeIdsOf(summary: VomUnifiedSummary): Set<string> {
  return new Set(summary.knownNodeIds.map((id) => String(id)));
}

function sumRecord(record: Record<string, number>): number {
  let total = 0;
  for (const value of Object.values(record)) total += Number(value) || 0;
  return total;
}

/**
 * 摘要自检：输出不变量违反列表（空数组 = 通过）。
 *
 * 这些不变量不依赖 JS 对照（避免“两边一起错”）：端点必须存在、计数必须自洽、
 * affordance/关系类型必须在枚举内、置信度必须在 [0,1]。rich.ts 在 observe 回包里
 * 暴露 `vomSelfCheck`；测试里直接断言为空。
 */
export function verifyVomSummary(summary: VomUnifiedSummary | null | undefined): string[] {
  const violations: string[] = [];
  if (!summary || typeof summary !== 'object') return ['摘要为空'];
  const ids = nodeIdsOf(summary);
  const nodeCount = summary.nodes.length;

  // 1) affordance：类型枚举、置信度、汇总自洽。
  const affordanceTypes = new Set<string>([...AFFORDANCE_TYPES, 'none']);
  for (const node of summary.nodes) {
    if (!node || !node.id) {
      violations.push('affordance 节点缺少 id');
      continue;
    }
    const result = node.affordance;
    if (!result || !affordanceTypes.has(String(result.type))) {
      violations.push('affordance 类型非法：' + String(node.id));
      continue;
    }
    if (!(Number(result.confidence) >= 0 && Number(result.confidence) <= 1)) {
      violations.push('affordance 置信度越界：' + String(node.id));
    }
    if (!Array.isArray(result.evidence) || result.evidence.length > 4) {
      violations.push('affordance evidence 超过 4 条：' + String(node.id));
    }
    if (!Array.isArray(result.alternatives) || result.alternatives.length > 2) {
      violations.push('affordance alternatives 超过 2 条：' + String(node.id));
    }
  }
  if (summary.affordance.total > nodeCount) violations.push('affordance.total 超过节点数');
  if (sumRecord(summary.affordance.byType) !== summary.affordance.total) {
    violations.push('affordance.byType 求和 != total');
  }

  // 2) relations：类型/置信度/端点/来源。
  const relationKinds = new Set<string>(RELATION_KINDS);
  const relationTypes: Record<string, number> = {};
  for (const relation of summary.relations.relations) {
    if (!relationKinds.has(String(relation.type))) violations.push('关系类型非法：' + String(relation.type));
    relationTypes[String(relation.type)] = (relationTypes[String(relation.type)] || 0) + 1;
    if (!(Number(relation.confidence) >= 0 && Number(relation.confidence) <= 1)) {
      violations.push('关系置信度越界：' + String(relation.from) + '→' + String(relation.to));
    }
    if (!Array.isArray(relation.sources) || relation.sources.length === 0) {
      violations.push('关系缺少 source：' + String(relation.from) + '→' + String(relation.to));
    }
    if (!ids.has(String(relation.from)) || !ids.has(String(relation.to))) {
      violations.push('关系端点不在节点集合：' + String(relation.from) + '→' + String(relation.to));
    }
  }
  if (summary.stats.relations !== summary.relations.relations.length) {
    violations.push('stats.relations 与关系列表长度不一致');
  }
  if (sumRecord(relationTypes) !== summary.relations.relations.length) {
    violations.push('关系类型计数与关系列表长度不一致');
  }
  for (const [type, count] of Object.entries(summary.stats.byRelationType)) {
    if (Number(count) !== (relationTypes[type] || 0)) violations.push('byRelationType 与关系列表不一致：' + type);
  }

  // 3) context/groups：计数与组列表自洽、组 id 不重复。
  if (summary.groups.total !== summary.context.groups.length) {
    violations.push('groups.total 与 context.groups 长度不一致');
  }
  if (summary.stats.contextGroups !== summary.context.groups.length) {
    violations.push('stats.contextGroups 与 context.groups 长度不一致');
  }
  const groupIds = new Set<string>();
  for (const group of summary.context.groups) {
    const id = String(group && group.id);
    if (!id) {
      violations.push('context 组缺少 id');
      continue;
    }
    if (groupIds.has(id)) violations.push('context 组 id 重复：' + id);
    groupIds.add(id);
  }
  for (const digest of summary.groups.groups) {
    if (!groupIds.has(String(digest.id))) violations.push('groups 摘要包含未知组：' + String(digest.id));
    if (Number(digest.members) < 0) violations.push('groups 成员数为负：' + String(digest.id));
  }
  if (summary.groups.shown > summary.groups.total) violations.push('groups.shown 超过 total');

  // 4) stats 截断标记与各图一致。
  if (summary.stats.truncated.relations !== summary.relations.stats.truncated) {
    violations.push('stats.truncated.relations 与关系图不一致');
  }
  if (summary.stats.truncated.contexts !== summary.context.stats.truncated) {
    violations.push('stats.truncated.contexts 与上下文模型不一致');
  }
  return violations;
}

/** 一行诊断文本（observe 回包的 vomSummaryText；不替代结构化字段）。 */
export function renderVomSummaryText(summary: VomUnifiedSummary | null | undefined): string {
  if (!summary) return 'VOM: (none)';
  const relationParts = Object.entries(summary.stats.byRelationType)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 6)
    .map(([type, count]) => type + '=' + String(count));
  const affordanceParts = Object.entries(summary.stats.byAffordanceType)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 6)
    .map(([type, count]) => type + '=' + String(count));
  const truncated = summary.stats.truncated.facts || summary.stats.truncated.graph
    || summary.stats.truncated.relations || summary.stats.truncated.contexts;
  return 'VOM: nodes=' + String(summary.stats.nodes)
    + ' affordance=' + String(summary.affordance.total)
    + (affordanceParts.length ? ' (' + affordanceParts.join(',') + ')' : '')
    + ' relations=' + String(summary.stats.relations)
    + (relationParts.length ? ' (' + relationParts.join(',') + ')' : '')
    + ' groups=' + String(summary.groups.total)
    + ' contexts=' + String(summary.stats.contexts)
    + ' frames=' + String(summary.stats.frames)
    + (truncated ? ' truncated' : '');
}
