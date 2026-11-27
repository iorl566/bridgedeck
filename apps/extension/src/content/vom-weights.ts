// src/content/vom-weights.ts —— observe --vom 的打分 / 计费 / 预算 / 排序 / 压缩（5b）。
//
// 为什么要有这一层：W7 系列把 VOM 的 affordance/relations/context 全部交给了
// packages/vom（单一实现），但“六阶段评分 + token 计费账本 + 预算裁剪 + 语义组预算”
// 一直没搬进 TS 运行时（rich.ts 只有启发式 vomScore、没有 vomWeights）。这里按
// 0.3.0 JS 页面库（extension/src/lib/vom-weights.js / vom-billing.js / vom-budget.js /
// vom-profile.js / vom-compact.js / vom-semantic.js）的**字段口径**做类型化移植：
//
// - token 估算复用 packages/vom/tokens.ts（VOM_TOKEN_SAFETY_FACTOR=1.1，不造第二套）；
// - 语义组不重造：直接消费 packages/vom context 的 groups（VomContextGroup）；
// - 计费模型：cjk-heuristic-v2 / chars-per-4 与 JS 逐值一致；o200k 需要随扩展打包的
//   词表（vendor/o200k），TS 扩展目前没有该资产 → 如实回退到 CJK 启发式并在
//   ledger.tokenizer/fallback 里标注，模型名仍是调用方请求的 o200k（不谎称走了 BPE）。
//
// 输出仍是 observe 既有字段名（vomWeights/vomExplain），不引入新契约。

import {
  VOM_TOKEN_SAFETY_FACTOR,
  estimateTextTokens as estimateCjkTextTokens,
  estimateVomTokens as estimateCjkVomTokens,
} from '../../../../packages/vom/src/index.ts';

/** 权重版本（与 JS VOM_WEIGHTS_VERSION 对齐）。 */
export const VOM_WEIGHTS_VERSION = 1;

/** token 安全系数（复用 packages/vom 的常量，保证与计费同口径）。 */
export { VOM_TOKEN_SAFETY_FACTOR };

/** 默认权重（与 JS DEFAULT_VOM_WEIGHTS 逐字段一致）。 */
export const DEFAULT_VOM_WEIGHTS: Readonly<Record<string, number>> = Object.freeze({
  interactive: 35,
  semanticRole: 14,
  formControl: 8,
  text: 4,
  area: 8,
  depth: -2,
  offscreen: -20,
  duplicate: -25,
  hidden: -70,
  disabled: -30,
  focused: 6,
  occluded: -10,
  inForm: 4,
  required: 3,
  invalid: 4,
  live: 2,
  heading: 4,
  lowContrast: -2,
  describedBy: 1,
  controls: 1,
  labelledBy: 1,
  pressed: 2,
  current: 3,
  hasPopup: 1,
  headingStrong: 2,
  range: 1,
  selected: 8,
  expanded: 2,
  checked: 2,
  landmark: 2,
});

/** 权重可覆盖的键（CLI --vom-weights 的合法键，与 lib/vom-weight-config.mjs 一致）。 */
export const VOM_WEIGHT_KEYS: readonly string[] = Object.freeze(Object.keys(DEFAULT_VOM_WEIGHTS));

/** 打分/过滤用的最小节点形状（RichNode 兼容）。 */
export interface VomScoreNodeLike {
  id?: string;
  ref?: string | null;
  role?: string | null;
  name?: string | null;
  tag?: string | null;
  interactive?: boolean;
  visible?: boolean;
  clickable?: boolean;
  inForm?: boolean;
  disabled?: boolean;
  lowContrast?: boolean;
  hitTest?: string | null;
  inViewport?: boolean;
  pointerEvents?: string;
  vomScore?: number;
  vomFactors?: string[];
  ancestors?: unknown[];
  rect?: { x?: number; y?: number; w?: number; h?: number; width?: number; height?: number } | null;
}

/** 单个评分因素（vom-explain 直接回给调用方）。 */
export interface VomScoreFactor {
  name: string;
  value: number;
  weight: number;
  score: number;
}

export interface VomScoreResult {
  score: number;
  factors: VomScoreFactor[];
}

function areaOf(node: VomScoreNodeLike): number {
  const rect = (node && typeof node.rect === 'object' && node.rect ? node.rect : {}) as Record<string, unknown>;
  const width = Number(rect['w'] != null ? rect['w'] : rect['width']) || 0;
  const height = Number(rect['h'] != null ? rect['h'] : rect['height']) || 0;
  return Math.max(0, width) * Math.max(0, height);
}

/** 统一的可见性事实（与 JS vom-visibility.visibilityFlags 同口径，只取节点已有字段）。 */
export function visibilityFlagsOf(node: VomScoreNodeLike): {
  offscreen: boolean;
  hiddenBlocked: boolean;
  hiddenAria: boolean;
  occluded: boolean;
} {
  const hitTest = String(node?.hitTest ?? '');
  return {
    offscreen: node?.inViewport === false || hitTest === 'offscreen',
    hiddenBlocked: node?.clickable === false && hitTest === 'blocked',
    hiddenAria: node?.visible === false,
    occluded: hitTest === 'blocked',
  };
}

/** 单节点打分（纯函数；factors 与 score 可解释）。 */
export function scoreVomNode(node: VomScoreNodeLike, weights: Record<string, number> = {}): VomScoreResult {
  const w: Record<string, number> = { ...DEFAULT_VOM_WEIGHTS, ...(weights || {}) };
  const visibility = visibilityFlagsOf(node);
  const factors: VomScoreFactor[] = [];
  const add = (name: string, value: number, weight: number | undefined): void => {
    if (!weight) return;
    factors.push({ name, value, weight, score: Math.round(value * weight) });
  };
  const role = String(node?.role ?? '');
  add('interactive', node?.interactive === true ? 1 : 0, w['interactive']);
  add('semanticRole', role ? 1 : 0, w['semanticRole']);
  add('formControl', /textbox|searchbox|combobox|checkbox|radio|switch/i.test(role) ? 1 : 0, w['formControl']);
  const textLength = typeof node?.name === 'string' ? node.name.length : 0;
  add('text', Math.min(3, textLength / 20), w['text']);
  const area = areaOf(node);
  add('area', area > 0 ? Math.min(2, Math.log10(area / 100 + 1)) : 0, w['area']);
  const depth = Array.isArray(node?.ancestors) ? node.ancestors.length : 0;
  add('depth', Math.max(0, Number(depth) || 0), w['depth']);
  add('offscreen', visibility.offscreen ? 1 : 0, w['offscreen']);
  add('hidden', visibility.hiddenBlocked ? 1 : 0, w['hidden']);
  add('hidden', visibility.hiddenAria ? 1 : 0, w['hidden']);
  add('disabled', node?.disabled === true ? 1 : 0, w['disabled']);
  add('occluded', visibility.occluded ? 1 : 0, w['occluded']);
  add('inForm', node?.inForm === true ? 1 : 0, w['inForm']);
  const tag = String(node?.tag ?? '');
  add('heading', /^h[1-6]$/i.test(tag) ? 1 : 0, w['heading']);
  add('lowContrast', node?.lowContrast === true ? 1 : 0, w['lowContrast']);
  add('headingStrong', /^h[12]$/i.test(tag) ? 1 : 0, w['headingStrong']);
  const ancestors = Array.isArray(node?.ancestors) ? node.ancestors : [];
  const landmark = ancestors.some((item) => {
    if (!item || typeof item !== 'object') return false;
    const roleName = String((item as { role?: unknown }).role ?? '');
    const tagName = String((item as { tag?: unknown }).tag ?? '');
    return ['main', 'navigation', 'banner', 'contentinfo', 'region', 'form'].includes(roleName)
      || ['main', 'nav', 'header', 'footer', 'form'].includes(tagName);
  });
  add('landmark', landmark ? 1 : 0, w['landmark']);
  // 祖先链在 rich.ts 里是 id 字符串（不是对象）：无法判定 landmark 时记 0，不臆测。
  const score = factors.reduce((sum, factor) => sum + factor.score, 0);
  return { score, factors };
}

/** 给节点附加 vomScore/vomFactors（原地写，保持对象身份，图/关系里的引用仍有效）。 */
export function attachVomScores<N extends VomScoreNodeLike>(
  nodes: readonly N[],
  weights: Record<string, number> = {},
): Array<N & { vomScore: number; vomFactors: string[] }> {
  const list = Array.isArray(nodes) ? nodes : [];
  return list.map((node) => {
    const scored = scoreVomNode(node, weights);
    node.vomScore = scored.score;
    node.vomFactors = scored.factors.map((factor) => factor.name).filter(Boolean);
    return node as N & { vomScore: number; vomFactors: string[] };
  });
}

/** 按分数排序（同分保持原始顺序）；limit>0 时截断。 */
export function rankVomNodes<N extends VomScoreNodeLike>(nodes: readonly N[], limit = 0): N[] {
  const scored = (Array.isArray(nodes) ? nodes.slice() : []).map((node, index) => ({
    node: node && Number.isInteger(node.vomScore) ? node : { ...node, vomScore: scoreVomNode(node).score } as N,
    index,
  }));
  scored.sort((a, b) => (Number(b.node.vomScore) - Number(a.node.vomScore)) || (a.index - b.index));
  const size = Number(limit) > 0 ? Math.min(Math.round(Number(limit)), scored.length) : scored.length;
  return scored.slice(0, size).map((item) => item.node);
}

/** 按最低分过滤。 */
export function filterVomNodesByScore<N extends VomScoreNodeLike>(nodes: readonly N[], minScore: number): N[] {
  const floor = Number(minScore);
  if (!Number.isFinite(floor)) return Array.isArray(nodes) ? nodes.slice() : [];
  return (Array.isArray(nodes) ? nodes : []).filter((node) => Number(node?.vomScore) >= floor);
}

// ---------------------------------------------------------------------------
// token 估算 / 计费账本
// ---------------------------------------------------------------------------

/** 节点 token 成本（复用 packages/vom：8 + name/role 文本成本）。 */
export function estimateVomTokens(node: VomScoreNodeLike | null | undefined): number {
  return estimateCjkVomTokens(node);
}

/** 文本 token 估算（复用 packages/vom CJK/emoji 口径）。 */
export function estimateTextTokens(text: unknown): number {
  return estimateCjkTextTokens(text);
}

export type VomBillingModel = 'cjk-heuristic-v2' | 'chars-per-4' | 'o200k';

/** 计费模型清单（诊断/参数校验用）。 */
export const VOM_BILLING_MODELS: readonly VomBillingModel[] = Object.freeze(['cjk-heuristic-v2', 'chars-per-4', 'o200k']);

export interface VomBillingLedger {
  /** 调用方请求的模型名（CLI --vom-billing-model）。 */
  model: VomBillingModel;
  /** 实际使用的 token 口径实现。 */
  tokenizer: 'cjk-heuristic-v2' | 'chars-per-4';
  /** o200k 词表不可用时为 true（如实标注，不谎称 BPE）。 */
  fallback: boolean;
  fallbackReason: string | null;
  safetyFactor: number;
  nodes: number;
  totalTokens: number;
  textTokens: number;
  structuralTokens: number;
  averageTokens: number;
}

function billingUnitOf(model: VomBillingModel): (node: VomScoreNodeLike) => number {
  if (model === 'chars-per-4') {
    return (node) => 8 + Math.ceil((String(node?.name ?? '').length / 4) * VOM_TOKEN_SAFETY_FACTOR);
  }
  if (model === 'o200k') {
    // o200k 词表（vendor/o200k/*.tiktoken）未随 TS 扩展打包；这里回退到 CJK 启发式，
    // 并在 ledger.tokenizer/fallback 里显式标注，避免把“回退值”当成真实 BPE 计费。
    return (node) => estimateCjkVomTokens(node);
  }
  return (node) => estimateCjkVomTokens(node);
}

/** 计费账本：模型可插拔，口径与字段名对齐 JS createBillingLedger。 */
export function createBillingLedger(
  nodes: readonly VomScoreNodeLike[],
  options: { model?: VomBillingModel | string } = {},
): VomBillingLedger {
  const requested = String(options.model ?? 'o200k') as VomBillingModel;
  const model: VomBillingModel = VOM_BILLING_MODELS.includes(requested) ? requested : 'cjk-heuristic-v2';
  const tokenizer: VomBillingLedger['tokenizer'] = model === 'chars-per-4' ? 'chars-per-4' : 'cjk-heuristic-v2';
  const fallback = model === 'o200k';
  const unit = billingUnitOf(model);
  const list = Array.isArray(nodes) ? nodes : [];
  let total = 0;
  let text = 0;
  let structural = 0;
  for (const node of list) {
    total += unit(node);
    text += estimateCjkTextTokens([node?.name, node?.role, node?.tag].filter(Boolean).join(' '));
    structural += 8;
  }
  return {
    model,
    tokenizer,
    fallback,
    fallbackReason: fallback ? 'o200k 词表（vendor/o200k）未随 TS 扩展打包，回退 cjk-heuristic-v2' : null,
    safetyFactor: VOM_TOKEN_SAFETY_FACTOR,
    nodes: list.length,
    totalTokens: total,
    textTokens: text,
    structuralTokens: structural,
    averageTokens: list.length ? Math.round((total / list.length) * 10) / 10 : 0,
  };
}

// ---------------------------------------------------------------------------
// 预算 / 档位 / 语义组预算 / 组压缩
// ---------------------------------------------------------------------------

/** VOM 档位（与 JS VOM_PROFILES 一致）。 */
export interface VomProfile {
  minScore?: number;
  maxNodes?: number;
  maxTokens?: number;
  excludeHidden?: boolean;
}

export const VOM_PROFILES: Readonly<Record<string, VomProfile>> = Object.freeze({
  balanced: { minScore: 0, maxNodes: 200, maxTokens: 8000 },
  compact: { minScore: 20, maxNodes: 80, maxTokens: 4000, excludeHidden: true },
  all: {},
});

export function resolveVomProfile(name: unknown): VomProfile | null {
  const key = String(name ?? '').trim().toLowerCase();
  if (!key) return null;
  return VOM_PROFILES[key] ?? null;
}

/** 节点/Token 预算结果（vomWeights.budgetPlan 的证据来源）。 */
export interface VomBudgetReport<N extends VomScoreNodeLike = VomScoreNodeLike> {
  budget: { nodes: number; tokens: number; groups: number; groupTokens: number };
  used: { nodes: number; tokens: number };
  trimmed: { groups: number; nodes: number; tokens: number; top: number };
  reason: 'none' | 'node-limit' | 'token-limit' | 'group-limit' | 'top-limit';
  nodes: N[];
  budgetNodes: number;
  budgetTokens: number;
  active: boolean;
}

function limitOf(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.floor(number);
}

/** 节点/Token/top 预算裁剪（保持传入顺序；不做背包替换，结果确定）。 */
export function evaluateVomBudget<N extends VomScoreNodeLike>(
  nodes: readonly N[],
  options: { maxNodes?: unknown; maxTokens?: unknown; top?: unknown } = {},
): VomBudgetReport<N> {
  const list = Array.isArray(nodes) ? nodes : [];
  const maxNodes = limitOf(options.maxNodes);
  const maxTokens = limitOf(options.maxTokens);
  const top = limitOf(options.top);
  const kept: N[] = [];
  let usedTokens = 0;
  let droppedTokens = 0;
  let droppedNodes = 0;
  let reason: VomBudgetReport['reason'] = 'none';
  for (const node of list) {
    const cost = Math.max(0, estimateVomTokens(node));
    if (top > 0 && kept.length >= top) {
      droppedNodes += 1;
      droppedTokens += cost;
      if (reason === 'none') reason = 'top-limit';
      continue;
    }
    if (maxNodes > 0 && kept.length >= maxNodes) {
      droppedNodes += 1;
      droppedTokens += cost;
      if (reason === 'none') reason = 'node-limit';
      continue;
    }
    if (maxTokens > 0 && usedTokens + cost > maxTokens) {
      droppedNodes += 1;
      droppedTokens += cost;
      if (reason === 'none') reason = 'token-limit';
      continue;
    }
    kept.push(node);
    usedTokens += cost;
  }
  return {
    budget: { nodes: maxNodes, tokens: maxTokens, groups: 0, groupTokens: 0 },
    used: { nodes: kept.length, tokens: usedTokens },
    trimmed: { groups: 0, nodes: droppedNodes, tokens: droppedTokens, top: 0 },
    reason,
    nodes: kept,
    budgetNodes: maxNodes,
    budgetTokens: maxTokens,
    active: Boolean(maxNodes || maxTokens || top),
  };
}

/** 一行诊断文本（与 JS summarizeVomBudget 同形）。 */
export function summarizeVomBudget(report: VomBudgetReport): string {
  return 'budget nodes=' + (report.budget.nodes || '∞') + ' tokens=' + (report.budget.tokens || '∞')
    + ' used=' + report.used.nodes + '/' + report.used.tokens
    + ' trimmed groups=' + report.trimmed.groups + ' nodes=' + report.trimmed.nodes
    + ' reason=' + report.reason;
}

/** packages/vom context 组的消费形状（不重造语义图）。 */
export interface VomGroupLite {
  id: string;
  groupKind?: string;
  memberIds?: string[];
  tokens?: number;
  members?: number;
  parentId?: string | null;
}

/** 语义组预算结果（vomWeights.semanticFiltered 的形状）。 */
export interface VomSemanticFiltered {
  groups: number;
  dropped: number;
  tokensUsed: number;
  contextGroups: number;
  groupsDropped: number;
  totalGroups: number;
}

/**
 * 语义组预算：只保留得分最高的 N 组（或按组 token 上限），组成员之外的不分组节点保留。
 * 组来自 packages/vom context（单一实现），这里只做选择与记账。
 */
export function applySemanticGroupBudget<N extends VomScoreNodeLike>(
  nodes: readonly N[],
  groups: readonly VomGroupLite[],
  options: { maxGroups?: unknown; minGroupScore?: unknown; maxGroupTokens?: unknown; includeContext?: boolean } = {},
): { nodes: N[]; semanticFiltered: VomSemanticFiltered } {
  const list = Array.isArray(nodes) ? nodes : [];
  const allGroups = Array.isArray(groups) ? groups : [];
  const limit = limitOf(options.maxGroups);
  const minScore = Math.max(0, Number(options.minGroupScore) || 0);
  const tokenLimit = limitOf(options.maxGroupTokens);
  const includeContext = options.includeContext === true;
  const scoreById = new Map<string, number>(list.map((node) => [String(node.id ?? ''), Number(node.vomScore) || 0]));
  const kindWeight: Record<string, number> = { dialog: 1.5, form: 1.3, table: 1.15, list: 1.1, row: 1, section: 1 };
  const candidates = allGroups.map((group) => {
    const members: string[] = Array.isArray(group.memberIds) ? group.memberIds : [];
    const raw = members.reduce((sum, id) => sum + (scoreById.get(String(id)) || 0), 0);
    const weight = kindWeight[String(group.groupKind ?? '')] ?? 1;
    const total = raw * weight;
    return {
      group,
      members,
      total,
      average: members.length ? total / members.length : 0,
      tokens: Number(group.tokens) || 0,
    };
  });
  const selected = candidates
    .filter((candidate) => !minScore || candidate.average >= minScore)
    .sort((a, b) => b.total - a.total)
    .slice(0, limit || candidates.length);
  let tokensUsed = 0;
  const bounded: typeof selected = [];
  for (const candidate of selected) {
    if (tokenLimit && bounded.length && tokensUsed + candidate.tokens > tokenLimit) break;
    bounded.push(candidate);
    tokensUsed += candidate.tokens;
  }
  const selectedIds = new Set(bounded.map((candidate) => candidate.group.id));
  let contextGroups = 0;
  if (includeContext) {
    const byId = new Map(allGroups.map((group) => [String(group.id), group]));
    for (const group of allGroups) {
      const parentId = group.parentId ? String(group.parentId) : '';
      if (!parentId || !selectedIds.has(String(group.id)) || selectedIds.has(parentId)) continue;
      const parent = byId.get(parentId);
      if (!parent) continue;
      selectedIds.add(parentId);
      contextGroups += 1;
    }
  }
  const keep = new Set<string>();
  for (const group of allGroups) {
    if (!selectedIds.has(String(group.id))) continue;
    for (const id of Array.isArray(group.memberIds) ? group.memberIds : []) keep.add(String(id));
  }
  const grouped = new Set<string>();
  for (const group of allGroups) {
    for (const id of Array.isArray(group.memberIds) ? group.memberIds : []) grouped.add(String(id));
  }
  const kept = list.filter((node) => !grouped.has(String(node.id ?? '')) || keep.has(String(node.id ?? '')));
  return {
    nodes: kept,
    semanticFiltered: {
      groups: bounded.length + contextGroups,
      dropped: Math.max(0, grouped.size - keep.size),
      tokensUsed,
      contextGroups,
      groupsDropped: Math.max(0, allGroups.length - (bounded.length + contextGroups)),
      totalGroups: allGroups.length,
    },
  };
}

/** 组压缩结果（vomWeights.compacted 的形状）。 */
export interface VomCompacted {
  nodes: VomScoreNodeLike[];
  groups: number;
  dropped: number;
}

/** 按语义组压缩：每组只保留得分最高的 N 个节点（或组 token 上限）；未分组节点保留。 */
export function compactVomNodesByGroups<N extends VomScoreNodeLike>(
  nodes: readonly N[],
  groups: readonly VomGroupLite[],
  options: { perGroup?: unknown; maxGroupTokens?: unknown } = {},
): { nodes: N[]; compacted: { groups: number; dropped: number } } {
  const list = Array.isArray(nodes) ? nodes : [];
  const perGroup = Math.min(limitOf(options.perGroup), 50);
  const maxGroupTokens = limitOf(options.maxGroupTokens);
  if (!perGroup && !maxGroupTokens) return { nodes: list.slice(), compacted: { groups: 0, dropped: 0 } };
  const byId = new Map<string, N>(list.map((node) => [String(node.id ?? ''), node]));
  const membership = new Map<string, N[]>();
  let groupCount = 0;
  for (const group of Array.isArray(groups) ? groups : []) {
    const members: N[] = [];
    for (const id of Array.isArray(group.memberIds) ? group.memberIds : []) {
      const node = byId.get(String(id));
      if (node) members.push(node);
    }
    if (!members.length) continue;
    groupCount += 1;
    membership.set(String(group.id), members);
  }
  const keep = new Set<N>();
  for (const members of membership.values()) {
    const sorted = members.slice().sort((a, b) => (Number(b.vomScore) || 0) - (Number(a.vomScore) || 0));
    let kept = 0;
    let tokens = 0;
    for (const node of sorted) {
      if (perGroup && kept >= perGroup) break;
      const cost = estimateVomTokens(node);
      if (maxGroupTokens && tokens + cost > maxGroupTokens) break;
      keep.add(node);
      kept += 1;
      tokens += cost;
    }
  }
  const groupedIds = new Set<string>();
  for (const group of Array.isArray(groups) ? groups : []) {
    for (const id of Array.isArray(group.memberIds) ? group.memberIds : []) groupedIds.add(String(id));
  }
  const keptList = list.filter((node) => {
    const id = String(node.id ?? '');
    if (!groupedIds.has(id)) return true;
    return keep.has(node);
  });
  return { nodes: keptList, compacted: { groups: groupCount, dropped: list.length - keptList.length } };
}

// ---------------------------------------------------------------------------
// observe --vom 的输入参数与管线
// ---------------------------------------------------------------------------

/** 与 CLI/daemon 对齐的 observe --vom 权重参数（camelCase）。 */
export interface VomWeightOptions {
  vomRank?: boolean;
  vomTop?: number;
  vomMinScore?: number;
  vomMaxNodes?: number;
  vomMaxTokens?: number;
  vomProfile?: string;
  vomExcludeHidden?: boolean;
  vomPerGroup?: number;
  vomGroupTokens?: number;
  vomSemanticMaxGroups?: number;
  vomSemanticMinScore?: number;
  vomSemanticMaxTokens?: number;
  vomGroupContext?: boolean;
  vomBillingModel?: string;
  vomExplain?: boolean;
  vomWeights?: Record<string, number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** 从内容脚本 observe 参数里提取权重开关（非法值忽略，不抛异常）。 */
export function vomWeightOptionsOf(params: Record<string, unknown>): VomWeightOptions {
  const options: VomWeightOptions = {};
  if (params['vomRank'] === true) options.vomRank = true;
  if (params['vomExplain'] === true) options.vomExplain = true;
  if (params['vomExcludeHidden'] === true) options.vomExcludeHidden = true;
  if (params['vomGroupContext'] === true) options.vomGroupContext = true;
  const top = finiteNumber(params['vomTop']);
  if (top !== null && top > 0) options.vomTop = Math.round(top);
  const minScore = finiteNumber(params['vomMinScore']);
  if (minScore !== null) options.vomMinScore = minScore;
  const maxNodes = finiteNumber(params['vomMaxNodes']);
  if (maxNodes !== null && maxNodes > 0) options.vomMaxNodes = Math.floor(maxNodes);
  const maxTokens = finiteNumber(params['vomMaxTokens']);
  if (maxTokens !== null && maxTokens > 0) options.vomMaxTokens = Math.floor(maxTokens);
  if (typeof params['vomProfile'] === 'string' && params['vomProfile']) options.vomProfile = params['vomProfile'];
  const perGroup = finiteNumber(params['vomPerGroup']);
  if (perGroup !== null && perGroup >= 0) options.vomPerGroup = Math.floor(perGroup);
  const groupTokens = finiteNumber(params['vomGroupTokens']);
  if (groupTokens !== null && groupTokens >= 0) options.vomGroupTokens = Math.floor(groupTokens);
  const semanticGroups = finiteNumber(params['vomSemanticMaxGroups']);
  if (semanticGroups !== null && semanticGroups > 0) options.vomSemanticMaxGroups = Math.floor(semanticGroups);
  const semanticMin = finiteNumber(params['vomSemanticMinScore']);
  if (semanticMin !== null) options.vomSemanticMinScore = semanticMin;
  const semanticTokens = finiteNumber(params['vomSemanticMaxTokens']);
  if (semanticTokens !== null && semanticTokens > 0) options.vomSemanticMaxTokens = Math.floor(semanticTokens);
  if (typeof params['vomBillingModel'] === 'string' && params['vomBillingModel']) options.vomBillingModel = params['vomBillingModel'];
  if (isRecord(params['vomWeights'])) {
    const weights: Record<string, number> = {};
    for (const [key, value] of Object.entries(params['vomWeights'])) {
      const number = finiteNumber(value);
      if (number !== null && VOM_WEIGHT_KEYS.includes(key)) weights[key] = number;
    }
    if (Object.keys(weights).length) options.vomWeights = weights;
  }
  return options;
}

/** vomWeights 回包（字段名与 JS observe 同形，E2E 5b 直接消费）。 */
export interface VomWeightsPayload {
  version: number;
  tokenSafetyFactor: number;
  estimatedTokens: number;
  billing: VomBillingLedger & { groups: number; grouped: number };
  budgetPlan: {
    nodeLimit: number | null;
    tokenLimit: number | null;
    groupLimit: number | null;
    nodes: number;
    tokens: number;
    semanticGroups: number | null;
    semanticTokens: number | null;
    groupDropped: number;
    nodeDropped: { nodes: number; tokens: number };
    budgetReason: string | null;
  };
  ranked: boolean;
  top: number | null;
  minScore: number | null;
  profile: string | null;
  excludeHidden: boolean;
  semanticFiltered: VomSemanticFiltered | null;
  perGroup: number | null;
  groupTokens: number | null;
  compacted: { groups: number; dropped: number } | null;
  budget: { nodes: number; tokens: number };
  custom: string[];
}

export interface VomPipelineResult<N extends VomScoreNodeLike> {
  nodes: N[];
  vomWeights: VomWeightsPayload;
  vomExplain: Record<string, VomScoreFactor[]> | null;
}

interface VomContextSummaryLike {
  groups?: VomGroupLite[];
  stats?: { groups?: number; contexts?: number };
  contexts?: unknown[];
}

/**
 * 应用 --vom 权重管线（与 JS observation.js 的 enrich/filter/rank/emit 顺序一致）：
 * 打分 → 语义组预算 → excludeHidden → minScore → rank → 组压缩 → 节点/token/top 预算。
 *
 * @param groups packages/vom context 的组（语义组预算/压缩的唯一来源）
 */
export function applyVomWeights<N extends VomScoreNodeLike>(
  nodes: readonly N[],
  groups: readonly VomGroupLite[],
  contextStats: { groups: number; grouped: number },
  options: VomWeightOptions = {},
): VomPipelineResult<N> {
  const profile = resolveVomProfile(options.vomProfile);
  const customWeights = options.vomWeights ?? {};
  const customKeys = Object.keys(customWeights);
  // 1) 打分（原地写 vomScore/vomFactors，保持节点对象身份）。
  let working: N[] = attachVomScores(nodes, customWeights) as N[];
  // 2) 语义组预算（--vom-semantic-max-groups / -min-score / -max-tokens / --vom-group-context）。
  let semanticFiltered: VomSemanticFiltered | null = null;
  if (options.vomSemanticMaxGroups !== undefined || options.vomSemanticMinScore !== undefined
    || options.vomSemanticMaxTokens !== undefined) {
    const applied = applySemanticGroupBudget(working, groups, {
      maxGroups: options.vomSemanticMaxGroups,
      minGroupScore: options.vomSemanticMinScore,
      maxGroupTokens: options.vomSemanticMaxTokens,
      includeContext: options.vomGroupContext === true,
    });
    working = applied.nodes;
    semanticFiltered = applied.semanticFiltered;
  }
  // 3) excludeHidden：只丢“画不出来”的节点（display/visibility/aria/可见性事实）。
  const excludeHidden = options.vomExcludeHidden === true || profile?.excludeHidden === true;
  const hiddenDropped = excludeHidden
    ? working.filter((node) => node.visible === false || node.inViewport === false)
    : [];
  if (hiddenDropped.length) working = working.filter((node) => !(node.visible === false || node.inViewport === false));
  // 4) 最低分（profile 优先于显式参数，与 JS 相同：显式参数 wins）。
  const minScore = options.vomMinScore !== undefined
    ? options.vomMinScore
    : (profile?.minScore !== undefined ? profile.minScore : undefined);
  if (minScore !== undefined) working = filterVomNodesByScore(working, minScore);
  // 5) 排序（--vom-rank）。
  const ranked = options.vomRank === true;
  if (ranked) working = rankVomNodes(working);
  // 6) 组压缩（--vom-per-group / --vom-group-tokens）。
  const compactRequested = options.vomPerGroup !== undefined || options.vomGroupTokens !== undefined;
  const compacted = compactRequested
    ? compactVomNodesByGroups(working, groups, { perGroup: options.vomPerGroup, maxGroupTokens: options.vomGroupTokens })
    : null;
  if (compacted) working = compacted.nodes;
  // 7) 节点/token/top 预算（profile 提供缺省上限）。
  const maxNodes = options.vomMaxNodes !== undefined ? options.vomMaxNodes : profile?.maxNodes;
  const maxTokens = options.vomMaxTokens !== undefined ? options.vomMaxTokens : profile?.maxTokens;
  const top = options.vomTop !== undefined && options.vomTop > 0 ? options.vomTop : 0;
  const report = evaluateVomBudget(working, { maxNodes, maxTokens, top });
  working = report.nodes;
  // 8) 计费账本（对最终节点计费；estimatedTokens 与 billing.totalTokens 同源）。
  const billing = createBillingLedger(working, { model: options.vomBillingModel ?? 'o200k' });
  const vomWeights: VomWeightsPayload = {
    version: VOM_WEIGHTS_VERSION,
    tokenSafetyFactor: VOM_TOKEN_SAFETY_FACTOR,
    estimatedTokens: billing.totalTokens,
    billing: {
      ...billing,
      groups: Number(contextStats.groups) || 0,
      grouped: Number(contextStats.grouped) || 0,
    },
    budgetPlan: {
      nodeLimit: report.budgetNodes || null,
      tokenLimit: report.budgetTokens || null,
      groupLimit: null,
      nodes: working.length,
      tokens: billing.totalTokens,
      semanticGroups: semanticFiltered ? semanticFiltered.groups : null,
      semanticTokens: semanticFiltered ? semanticFiltered.tokensUsed : null,
      groupDropped: semanticFiltered ? semanticFiltered.dropped : 0,
      nodeDropped: { nodes: report.trimmed.nodes, tokens: report.trimmed.tokens },
      budgetReason: report.reason === 'none' ? null : report.reason,
    },
    ranked,
    top: top > 0 ? top : null,
    minScore: minScore === undefined ? null : Number(minScore),
    profile: options.vomProfile ?? null,
    excludeHidden,
    semanticFiltered,
    perGroup: options.vomPerGroup !== undefined ? Number(options.vomPerGroup) : null,
    groupTokens: options.vomGroupTokens !== undefined ? Number(options.vomGroupTokens) : null,
    compacted: compacted ? { groups: compacted.compacted.groups, dropped: compacted.compacted.dropped } : null,
    budget: { nodes: report.trimmed.nodes, tokens: report.trimmed.tokens },
    custom: customKeys,
  };
  let vomExplain: Record<string, VomScoreFactor[]> | null = null;
  if (options.vomExplain === true) {
    vomExplain = {};
    for (const node of working) {
      const key = String(node.ref || node.id || node.name || 'node');
      vomExplain[key] = scoreVomNode(node, customWeights).factors;
    }
  }
  return { nodes: working, vomWeights, vomExplain };
}

/** context 统计（billing.groups/grouped 的兜底来源）。 */
export function contextStatsOf(context: VomContextSummaryLike | null | undefined): { groups: number; grouped: number } {
  const groups = Array.isArray(context?.groups) ? context.groups : [];
  let grouped = 0;
  for (const group of groups) grouped += Array.isArray(group?.memberIds) ? group.memberIds.length : 0;
  const contexts = Array.isArray(context?.contexts) ? context.contexts.length : 0;
  return {
    groups: groups.length || Number(context?.stats?.groups) || 0,
    grouped: grouped || Number(context?.stats?.contexts) || contexts || 0,
  };
}
