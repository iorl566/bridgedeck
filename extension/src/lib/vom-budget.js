// lib/vom-budget.js —— VOM token/node/group 预算的强制与裁剪报告。
//
// 约定：budget = 调用方给的硬上限；used = 实际保留量；trimmed = 因预算被裁掉的数量；
// reason = 触发裁剪的第一原因。输出形状固定为
//   { budget:{nodes,tokens}, used:{nodes,tokens}, trimmed:{groups,nodes,tokens}, reason }
// 供 observe 直接回给 Agent（`vomBudget`），并作为 capture 漏斗 emit 阶段的计数来源。
//
// 计费口径保持既有实现：默认 unit = estimateVomTokens(name+role)，不引入新 tokenizer；
// 想用 o200k 等既有模型时由调用方传 unit（billing ledger 的 impl.unit），不改变默认数值。
//
// 纯函数，可单测；不读页面、不碰观测缓存。

import { estimateVomTokens } from './vom-weights.js';
import { filterSemanticGroups } from './vom-semantic.js';

export const VOM_BUDGET_VERSION = 1;

export const VOM_BUDGET_REASONS = Object.freeze({
  none: 'none',
  node: 'node-limit',
  token: 'token-limit',
  group: 'group-limit',
  top: 'top-limit',
});

function limitOf(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.floor(number);
}

function unitOf(options) {
  if (options && typeof options.unit === 'function') return options.unit;
  return (node) => estimateVomTokens(node);
}

/**
 * 归一化预算输入：既接受扁平 {maxNodes,maxTokens,top,groups}，也接受
 * observe 的 `vomBudget` 对象；负数/NaN 一律当“无上限”。
 */
export function normalizeVomBudget(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const nodeLimit = limitOf(source.maxNodes != null ? source.maxNodes : source.nodes);
  const tokenLimit = limitOf(source.maxTokens != null ? source.maxTokens : source.tokens);
  const topLimit = limitOf(source.top);
  const groupLimit = limitOf(source.maxGroups != null ? source.maxGroups : source.groups);
  const groupTokenLimit = limitOf(source.groupTokens != null ? source.groupTokens : source.maxGroupTokens);
  return {
    version: VOM_BUDGET_VERSION,
    nodes: nodeLimit,
    tokens: tokenLimit,
    top: topLimit,
    groups: groupLimit,
    groupTokens: groupTokenLimit,
    active: Boolean(nodeLimit || tokenLimit || topLimit || groupLimit || groupTokenLimit),
  };
}

/** 单节点预算成本：默认与既有计费完全一致（name+role）。 */
export function budgetCostOf(node, options = {}) {
  return Math.max(0, Number(unitOf(options)(node)) || 0);
}

/**
 * 按节点数/token 上限裁剪（保持传入顺序，不做二次排序）。
 * - 先到 node 上限：后续节点理由 node-limit；
 * - token 累加超限：该节点理由 token-limit（不做背包/替换，保证确定性）。
 * @returns {{nodes:Array, kept:number, budget:{nodes:number,tokens:number},
 *   used:{nodes:number,tokens:number}, trimmed:{groups:number,nodes:number,tokens:number},
 *   reason:string, reasons:object, drops:Array, active:boolean, version:number}}
 */
export function evaluateVomBudget(nodes, options = {}) {
  const list = Array.isArray(nodes) ? nodes : [];
  const budget = normalizeVomBudget(options);
  const unit = unitOf(options);
  const kept = [];
  const drops = [];
  const reasons = { 'node-limit': 0, 'token-limit': 0 };
  let usedTokens = 0;
  let droppedTokens = 0;
  for (const node of list) {
    const cost = Math.max(0, Number(unit(node)) || 0);
    if (budget.nodes > 0 && kept.length >= budget.nodes) {
      drops.push({ id: nodeIdOf(node, drops.length), reason: VOM_BUDGET_REASONS.node, cost });
      reasons['node-limit'] += 1;
      droppedTokens += cost;
      continue;
    }
    if (budget.tokens > 0 && usedTokens + cost > budget.tokens) {
      drops.push({ id: nodeIdOf(node, drops.length), reason: VOM_BUDGET_REASONS.token, cost });
      reasons['token-limit'] += 1;
      droppedTokens += cost;
      continue;
    }
    kept.push(node);
    usedTokens += cost;
  }
  const primary = reasons['node-limit'] ? VOM_BUDGET_REASONS.node
    : reasons['token-limit'] ? VOM_BUDGET_REASONS.token
      : VOM_BUDGET_REASONS.none;
  return {
    version: VOM_BUDGET_VERSION,
    active: budget.active,
    nodes: kept,
    kept: kept.length,
    budget: { nodes: budget.nodes, tokens: budget.tokens },
    used: { nodes: kept.length, tokens: usedTokens },
    trimmed: { groups: 0, nodes: drops.length, tokens: droppedTokens },
    reason: primary,
    reasons,
    drops,
  };
}

function nodeIdOf(node, index) {
  if (node && typeof node === 'object') {
    if (node.id != null && node.id !== '') return String(node.id);
    if (node.ref) return String(node.ref);
    if (node.stableRef) return String(node.stableRef);
  }
  return 'n' + index;
}

/**
 * 组级预算：按传入顺序（调用方先按得分排序）保留前 N 组 / 累计 token 不超限，
 * 返回保留组与裁剪统计。用于 `--vom-budget.groups` 和诊断里的组裁剪计数。
 * @param {Array<{id:string,tokens?:number,members?:number,memberIds?:string[]}>} groups
 */
export function trimVomGroups(groups, { maxGroups = 0, maxTokens = 0, costOf = null } = {}) {
  const list = Array.isArray(groups) ? groups : [];
  const groupLimit = limitOf(maxGroups);
  const tokenLimit = limitOf(maxTokens);
  const cost = typeof costOf === 'function' ? costOf : (group) => Math.max(0, Number(group && group.tokens) || 0);
  if (!groupLimit && !tokenLimit) {
    return {
      version: VOM_BUDGET_VERSION,
      groups: list,
      kept: list.length,
      dropped: 0,
      used: { groups: list.length, tokens: list.reduce((sum, group) => sum + cost(group), 0) },
      trimmed: { groups: 0, tokens: 0 },
      reason: VOM_BUDGET_REASONS.none,
      active: false,
    };
  }
  const kept = [];
  let usedTokens = 0;
  let droppedGroups = 0;
  let droppedTokens = 0;
  let reason = VOM_BUDGET_REASONS.none;
  for (const group of list) {
    const groupCost = Math.max(0, Number(cost(group)) || 0);
    if (groupLimit > 0 && kept.length >= groupLimit) {
      droppedGroups += 1;
      droppedTokens += groupCost;
      reason = VOM_BUDGET_REASONS.group;
      continue;
    }
    if (tokenLimit > 0 && kept.length > 0 && usedTokens + groupCost > tokenLimit) {
      droppedGroups += 1;
      droppedTokens += groupCost;
      if (reason === VOM_BUDGET_REASONS.none) reason = VOM_BUDGET_REASONS.token;
      continue;
    }
    kept.push(group);
    usedTokens += groupCost;
  }
  return {
    version: VOM_BUDGET_VERSION,
    groups: kept,
    kept: kept.length,
    dropped: droppedGroups,
    used: { groups: kept.length, tokens: usedTokens },
    trimmed: { groups: droppedGroups, tokens: droppedTokens },
    reason,
    active: true,
  };
}

/**
 * 语义组过滤 + 组预算记账。observe 的 semantic 过滤走这里，保证
 * “选了哪些组 / 裁了几组”只有一个口径；底层仍是既有的 filterSemanticGroups。
 */
export function applySemanticBudget(entries, graph, options = {}) {
  const filtered = filterSemanticGroups(entries, graph, options);
  if (!filtered) return null;
  const totalGroups = graph && Array.isArray(graph.nodes) ? graph.nodes.length : 0;
  const keptGroups = Math.max(0, Number(filtered.groups) || 0);
  const groupsDropped = Math.max(0, totalGroups - keptGroups);
  return {
    ...filtered,
    totalGroups,
    keptGroups,
    groupsDropped,
    reason: groupsDropped ? VOM_BUDGET_REASONS.group : VOM_BUDGET_REASONS.none,
  };
}

/**
 * 把节点预算 + 组预算 + top 裁剪合成统一报告。
 * top 语义：节点预算选完后只保留前 N 个（既有 --vom-top 行为），被裁的记 top-limit。
 */
export function buildVomBudgetReport({ nodes = [], nodeBudget = null, groupTrim = null, top = 0, unit = null } = {}) {
  const nodeLimit = normalizeVomBudget(nodeBudget || {});
  const costOf = unitOf({ unit: unit || undefined });
  const evaluation = evaluateVomBudget(nodes, {
    maxNodes: nodeLimit.nodes,
    maxTokens: nodeLimit.tokens,
    unit: unit || undefined,
  });
  let kept = evaluation.nodes;
  const extraDrops = [];
  let topTrimmed = 0;
  let topCutTokens = 0;
  const topLimit = limitOf(top);
  if (topLimit > 0 && kept.length > topLimit) {
    const cut = kept.slice(topLimit);
    topTrimmed = cut.length;
    for (const node of cut) {
      const cost = Math.max(0, Number(costOf(node)) || 0);
      topCutTokens += cost;
      extraDrops.push({ id: nodeIdOf(node, extraDrops.length), reason: VOM_BUDGET_REASONS.top, cost });
    }
    kept = kept.slice(0, topLimit);
  }
  const groupTrimmed = groupTrim && typeof groupTrim === 'object' ? groupTrim : null;
  const trimmedGroups = groupTrimmed ? Math.max(0, Number(groupTrimmed.trimmed && groupTrimmed.trimmed.groups != null
    ? groupTrimmed.trimmed.groups
    : groupTrimmed.dropped) || 0) : 0;
  const trimmedNodes = evaluation.trimmed.nodes + topTrimmed;
  const trimmedTokens = evaluation.trimmed.tokens + extraDrops.reduce((sum, drop) => sum + drop.cost, 0);
  const reason = evaluation.reason !== VOM_BUDGET_REASONS.none
    ? evaluation.reason
    : topTrimmed ? VOM_BUDGET_REASONS.top
      : trimmedGroups ? VOM_BUDGET_REASONS.group
        : VOM_BUDGET_REASONS.none;
  return {
    version: VOM_BUDGET_VERSION,
    budget: {
      nodes: evaluation.budget.nodes,
      tokens: evaluation.budget.tokens,
      groups: nodeLimit.groups || 0,
      groupTokens: nodeLimit.groupTokens || 0,
    },
    used: { nodes: kept.length, tokens: Math.max(0, evaluation.used.tokens - topCutTokens) },
    trimmed: { groups: trimmedGroups, nodes: trimmedNodes, tokens: trimmedTokens, top: topTrimmed },
    reason,
    nodes: kept,
    drops: evaluation.drops.concat(extraDrops),
    active: Boolean(nodeLimit.active || topLimit || trimmedGroups || trimmedNodes),
  };
}

/** 一行摘要（observe 诊断字段 vomBudget.text）。 */
export function summarizeVomBudget(report) {
  if (!report || typeof report !== 'object') return '';
  const budget = report.budget || {};
  const used = report.used || {};
  const trimmed = report.trimmed || {};
  return 'budget nodes=' + (budget.nodes || '∞') + ' tokens=' + (budget.tokens || '∞')
    + ' used=' + (used.nodes || 0) + '/' + (used.tokens || 0)
    + ' trimmed groups=' + (trimmed.groups || 0) + ' nodes=' + (trimmed.nodes || 0)
    + ' reason=' + (report.reason || VOM_BUDGET_REASONS.none);
}
