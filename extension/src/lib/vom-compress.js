// lib/vom-compress.js —— 语义压缩：按 VOM 分组/关系折叠同类条目并输出 compression 报告（纯函数）。
//
// 目的：大页面里同一组（landmark/form/table）或同一 "owner → 多个 option" 关系会重复出现
// 几十条同形条目。Agent 需要的是“这个组里有 18 个选项，样例是 A/B/C”，而不是 18 行。
// 本模块做两件事：
//   1) 组折叠：把一个组里的成员节点合并成一条 summary 条目（计数 + 样例 + 角色直方图 + token 节省）；
//   2) 关系折叠：同一 (type, from) 下重复的目标合并成一条带 count 的折叠关系。
// 输出带 report（before/after nodes/tokens、ratio、folds、byKind），供 observe 与诊断直接读。
//
// 计费口径与 vom-weights.estimateVomTokens 完全一致（只按 name+role），压缩不会改变计费模型：
// summary 条目按自身的 name+role 计费，report 里的 tokensSaved 是“折叠前 - 折叠后”的差。

import { estimateVomTokens } from './vom-weights.js';

export const VOM_COMPRESSION_VERSION = 1;

export const COMPRESSION_LIMITS = Object.freeze({
  folds: 24,
  sampleNames: 3,
  relationFolds: 16,
  relationFoldMin: 3,
  relationTos: 4,
});

const KIND_ORDER = Object.freeze({ table: 0, form: 1, landmark: 2, section: 3, row: 4 });
const RANK = Object.freeze({ table: 0, form: 1, landmark: 2 });

function limitOf(value, fallback, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.floor(number), max);
}

function textOf(node) {
  if (!node) return '';
  return String(node.name != null ? node.name : '');
}

function groupUnits(input) {
  const units = [];
  const context = input.context && typeof input.context === 'object' ? input.context : null;
  if (context && Array.isArray(context.groups)) {
    for (const group of context.groups) {
      if (!group || !Array.isArray(group.memberIds)) continue;
      units.push({
        id: String(group.id),
        kind: group.kind || group.groupKind || 'group',
        groupKind: group.groupKind || null,
        name: group.name || null,
        role: group.role || null,
        memberIds: group.memberIds.map(String),
        tokens: Number(group.tokens) || 0,
        source: 'context',
      });
    }
  }
  if (!units.length && input.groups && typeof input.groups === 'object') {
    for (const kind of ['sections', 'rows', 'forms']) {
      for (const group of Array.isArray(input.groups[kind]) ? input.groups[kind] : []) {
        if (!group || !Array.isArray(group.nodeIds)) continue;
        units.push({
          id: 'g:' + kind + ':' + String(group.id),
          kind: kind === 'sections' ? 'landmark' : (kind === 'rows' ? 'row' : 'form'),
          groupKind: kind === 'sections' ? 'section' : (kind === 'rows' ? 'row' : 'form'),
          name: group.anchor && group.anchor.id ? '#' + group.anchor.id : null,
          role: group.anchor && group.anchor.role ? group.anchor.role : null,
          memberIds: group.nodeIds.map(String),
          tokens: Number(group.tokens) || 0,
          source: 'groups',
        });
      }
    }
  }
  if (!units.length && input.semantic && Array.isArray(input.semantic.nodes)) {
    for (const node of input.semantic.nodes) {
      if (!node || !Array.isArray(node.memberIds)) continue;
      units.push({
        id: String(node.id),
        kind: node.groupKind || 'group',
        groupKind: node.groupKind || null,
        name: null,
        role: null,
        memberIds: node.memberIds.map(String),
        tokens: Number(node.tokens) || 0,
        source: 'semantic',
      });
    }
  }
  units.sort((a, b) => {
    const left = KIND_ORDER[a.kind] != null ? KIND_ORDER[a.kind] : 9;
    const right = KIND_ORDER[b.kind] != null ? KIND_ORDER[b.kind] : 9;
    if (left !== right) return left - right;
    return b.memberIds.length - a.memberIds.length;
  });
  return units;
}

function relationListOf(relations) {
  if (Array.isArray(relations)) return relations;
  if (relations && Array.isArray(relations.relations)) return relations.relations;
  return [];
}

function foldRelations(relations, options) {
  const minCount = limitOf(options.relationFoldMin, COMPRESSION_LIMITS.relationFoldMin, 100);
  const maxFolds = limitOf(options.relationFolds, COMPRESSION_LIMITS.relationFolds, 500);
  const maxTos = limitOf(options.relationTos, COMPRESSION_LIMITS.relationTos, 64);
  const buckets = new Map();
  for (const relation of relations) {
    if (!relation || !relation.type || relation.from == null) continue;
    const key = relation.type + '\u0000' + String(relation.from);
    const bucket = buckets.get(key) || {
      type: relation.type,
      from: String(relation.from),
      count: 0,
      confidenceSum: 0,
      targets: [],
      sources: new Set(),
    };
    bucket.count += 1;
    bucket.confidenceSum += Number(relation.confidence) || 0;
    if (bucket.targets.length < maxTos) bucket.targets.push(String(relation.to));
    for (const source of Array.isArray(relation.sources) ? relation.sources : [relation.source]) {
      if (source) bucket.sources.add(source);
    }
    buckets.set(key, bucket);
  }
  const folds = [];
  for (const bucket of buckets.values()) {
    if (bucket.count < minCount) continue;
    folds.push({
      type: bucket.type,
      from: bucket.from,
      count: bucket.count,
      targets: bucket.targets.slice(),
      sources: [...bucket.sources],
      averageConfidence: Math.round((bucket.confidenceSum / bucket.count) * 1000) / 1000,
    });
  }
  folds.sort((a, b) => b.count - a.count);
  const kept = folds.slice(0, maxFolds);
  return { folds: kept, foldedRelations: kept.reduce((sum, fold) => sum + fold.count, 0), total: folds.length };
}

/**
 * @param {{nodes?:Array, relations?:object|Array, context?:object, groups?:object, semantic?:object}} input
 * @param {{maxFolds?:number, sampleNames?:number, minMembers?:number, includeRelationFolds?:boolean,
 *          relationFoldMin?:number, relationFolds?:number, relationTos?:number}} [options]
 * @returns {{version:number, nodes:object[], folded:object[], relationFolds:object[], report:object}}
 */
export function compressVomByRelations(input = {}, options = {}) {
  const nodes = Array.isArray(input.nodes) ? input.nodes.filter((node) => node && node.id != null) : [];
  const maxFolds = limitOf(options.maxFolds, COMPRESSION_LIMITS.folds, 200);
  const sampleNames = limitOf(options.sampleNames, COMPRESSION_LIMITS.sampleNames, 12);
  const minMembers = limitOf(options.minMembers, 2, 100);
  const nodeById = new Map();
  for (const node of nodes) nodeById.set(String(node.id), node);
  const beforeTokens = nodes.reduce((sum, node) => sum + estimateVomTokens(node), 0);
  const units = groupUnits(input);
  const foldedIds = new Set();
  const folded = [];
  const byKind = {};
  for (const unit of units) {
    if (folded.length >= maxFolds) break;
    const members = unit.memberIds.filter((id) => nodeById.has(id) && !foldedIds.has(id));
    if (members.length < minMembers) continue;
    const memberNodes = members.map((id) => nodeById.get(id));
    const tokensBefore = memberNodes.reduce((sum, node) => sum + estimateVomTokens(node), 0);
    const roles = {};
    for (const node of memberNodes) {
      const role = String(node.role || 'generic').toLowerCase();
      roles[role] = (roles[role] || 0) + 1;
    }
    const sample = memberNodes
      .map((node) => textOf(node))
      .filter(Boolean)
      .slice(0, sampleNames);
    const label = unit.name ? String(unit.name) : (unit.groupKind || unit.kind);
    const summary = {
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
    };
    summary.tokens = estimateVomTokens(summary);
    const ratio = tokensBefore > 0 ? summary.tokens / tokensBefore : 1;
    summary.tokensSaved = Math.max(0, tokensBefore - summary.tokens);
    summary.ratio = Math.round(ratio * 1000) / 1000;
    for (const id of members) foldedIds.add(id);
    folded.push(summary);
    byKind[unit.kind] = (byKind[unit.kind] || 0) + 1;
  }
  const kept = [];
  for (const node of nodes) if (!foldedIds.has(String(node.id))) kept.push(node);
  const afterTokens = kept.reduce((sum, node) => sum + estimateVomTokens(node), 0)
    + folded.reduce((sum, fold) => sum + fold.tokens, 0);
  const relations = relationListOf(input.relations);
  const relationFoldResult = options.includeRelationFolds === false
    ? { folds: [], foldedRelations: 0, total: 0 }
    : foldRelations(relations, options);
  const foldedTokens = folded.reduce((sum, fold) => sum + fold.tokensSaved, 0);
  return {
    version: VOM_COMPRESSION_VERSION,
    nodes: kept,
    folded,
    relationFolds: relationFoldResult.folds,
    report: {
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
    },
  };
}

/** 语义压缩报告的一行摘要。 */
export function summarizeVomCompression(report) {
  const value = report && report.report ? report.report : report;
  if (!value || !value.before) return 'compression: n/a';
  const parts = [
    'nodes ' + value.before.nodes + '→' + value.after.nodes,
    'tokens ' + value.before.tokens + '→' + value.after.tokens,
    'saved=' + value.saved.tokens + ' (' + Math.round((value.saved.ratio || 0) * 100) + '%)',
    'folds=' + value.folds,
    'members=' + value.foldedMembers,
    'relation-folds=' + value.relationFolds,
  ];
  return parts.join(' ');
}
