// lib/vom-degrade.js —— VOM 证据完整性与降级报告（纯函数）。
//
// observe 的 VOM 管线会在多处主动“降级”而不是失败：预算裁剪节点/令牌、可见性 gate
// 丢弃节点、页面侧漏斗提前丢元素、跨帧图截断、AX 兜底、关系图/视觉对象截断……
// 如果这些只散在各自字段里，调用方很容易把“被裁剪过的观察”当成全量事实。
//
// 本模块把它们汇总成一份**可核对的证据报告**：
//   evidence     —— 每类事实（capture/budget/layers/geometry/relations/visual/ax/frames/
//                   billing/zorder）是否采集到、数量、来源；没采集到的标 available:false +
//                   reason（'not-collected' / 'upstream-unavailable'），不补造；
//   budgets      —— token / 节点 / 分组 / 边的预算、已用、裁剪量与触发原因；
//   degradations —— 每一条降级的 code/stage/reason/count/impact/evidence（impact 分为
//                   correctness（事实缺失会影响判断）、recall（完整性问题）、diagnostic）；
//   missing      —— 结构化缺失清单（含影响面），供 audit/诊断直接标注“证据不足”。
//
// 纯函数：输入全部是管线已产出的报告对象，不读 DOM/CDP。

export const VOM_EVIDENCE_VERSION = 1;

/** 证据类别；也是完整性评分的分母。 */
export const EVIDENCE_KINDS = Object.freeze(['capture', 'budget', 'layers', 'geometry', 'relations', 'visual', 'ax', 'frames', 'billing', 'zorder']);

/** 完整性评分时权重要求最低存在的证据（事实正确性相关）。 */
export const REQUIRED_EVIDENCE = Object.freeze(['geometry', 'relations', 'layers']);

export const DEGRADE_CODES = Object.freeze({
  captureDropped: 'capture-dropped',
  budgetTrimmed: 'budget-trimmed',
  gateDropped: 'gate-dropped',
  fallback: 'pipeline-fallback',
  truncated: 'truncated',
  frameGap: 'frame-gap',
  evidenceMissing: 'evidence-missing',
  stageIssue: 'stage-issue',
  relationIntegrity: 'relation-integrity',
  visualBlocked: 'visual-blocked',
});

export const DEGRADE_IMPACT = Object.freeze({
  correctness: 'correctness',
  recall: 'recall',
  diagnostic: 'diagnostic',
});

export const EVIDENCE_LIMITS = Object.freeze({ degradations: 64, missing: 24, budgets: 8, reasonsPerStage: 12 });

function limitOf(value, fallback, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.floor(number), max);
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function evidenceEntry(kind, options = {}) {
  const counts = options.counts && typeof options.counts === 'object' ? { ...options.counts } : null;
  if (options.available === true) {
    return {
      kind,
      available: true,
      source: options.source || null,
      ...(counts ? { counts } : {}),
      ...(options.truncated === true ? { truncated: true } : {}),
    };
  }
  return {
    kind,
    available: false,
    reason: options.reason || 'not-collected',
    impact: options.impact || DEGRADE_IMPACT.diagnostic,
  };
}

function captureEvidence(capture) {
  if (!capture || typeof capture !== 'object' || !Array.isArray(capture.stages) || !capture.stages.length) {
    return evidenceEntry('capture', { available: false, reason: 'upstream-unavailable', impact: DEGRADE_IMPACT.recall });
  }
  let input = 0;
  let output = 0;
  let dropped = 0;
  for (const stage of capture.stages) {
    input += Math.max(0, Number(stage.input) || 0);
    output += Math.max(0, Number(stage.output) || 0);
    dropped += Math.max(0, Number(stage.dropped) || 0);
  }
  return evidenceEntry('capture', {
    available: true,
    source: 'vom-capture',
    counts: { stages: capture.stages.length, input, output, dropped },
    truncated: capture.truncated === true,
  });
}

function stageDegradations(capture, max) {
  const out = [];
  if (!capture || !Array.isArray(capture.stages)) return out;
  for (const stage of capture.stages) {
    if (out.length >= max) break;
    if (Number(stage.dropped) > 0) {
      out.push({
        code: DEGRADE_CODES.captureDropped,
        stage: String(stage.name || 'unknown'),
        reason: 'pipeline-drop',
        count: Math.max(0, Number(stage.dropped) || 0),
        impact: DEGRADE_IMPACT.recall,
        evidence: (Array.isArray(stage.dropReasons) ? stage.dropReasons : []).slice(0, EVIDENCE_LIMITS.reasonsPerStage),
      });
    }
    if (stage.error) {
      out.push({
        code: DEGRADE_CODES.stageIssue,
        stage: String(stage.name || 'unknown'),
        reason: 'stage-error',
        count: 1,
        impact: DEGRADE_IMPACT.correctness,
        evidence: { error: String(stage.error).slice(0, 200) },
      });
    }
  }
  return out;
}

function budgetEntries(budget, graph) {
  const entries = [];
  if (budget && typeof budget === 'object') {
    const limits = budget.budget || {};
    const used = budget.used || {};
    const trimmed = budget.trimmed || {};
    const push = (kind, limit, usedValue, trimmedValue) => {
      const limitValue = numberOrNull(limit);
      if (limitValue === null && !numberOrNull(trimmedValue)) return;
      entries.push({
        kind,
        limit: limitValue,
        used: numberOrNull(usedValue),
        trimmed: numberOrNull(trimmedValue) || 0,
        reason: budget.reason || 'none',
        active: budget.active === true,
      });
    };
    push('nodes', limits.nodes, used.nodes, trimmed.nodes);
    push('tokens', limits.tokens, used.tokens, trimmed.tokens);
    push('groups', limits.groups, used.groups, trimmed.groups);
  }
  if (graph && typeof graph === 'object' && graph.counts) {
    entries.push({
      kind: 'edges',
      limit: numberOrNull(graph.limit && graph.limit.edges),
      used: numberOrNull(graph.counts.edges),
      trimmed: graph.truncated === true ? 1 : 0,
      reason: graph.truncated === true ? 'graph-truncated' : 'none',
      active: graph.truncated === true,
    });
  }
  return entries;
}

function budgetDegradations(budgets, max) {
  const out = [];
  for (const entry of budgets) {
    if (out.length >= max) break;
    if (Number(entry.trimmed) > 0) {
      out.push({
        code: DEGRADE_CODES.budgetTrimmed,
        stage: 'emit',
        reason: entry.kind + ':' + (entry.reason || 'limit'),
        count: Number(entry.trimmed) || 0,
        impact: DEGRADE_IMPACT.recall,
        evidence: { kind: entry.kind, limit: entry.limit, used: entry.used },
      });
    }
  }
  return out;
}

function gateDegradations(gate, max) {
  const out = [];
  if (!gate || typeof gate !== 'object' || !gate.byReason) return out;
  for (const [reason, raw] of Object.entries(gate.byReason)) {
    if (out.length >= max) break;
    const count = Number(raw) || 0;
    if (count <= 0) continue;
    out.push({
      code: DEGRADE_CODES.gateDropped,
      stage: 'filter',
      reason,
      count,
      impact: DEGRADE_IMPACT.recall,
      evidence: { mode: gate.mode || null },
    });
  }
  return out;
}

function zorderMissing(zorder, max) {
  const out = [];
  if (!zorder || !Array.isArray(zorder.missing)) return out;
  for (const item of zorder.missing) {
    if (out.length >= max) break;
    out.push({
      evidence: String(item.evidence || 'unknown'),
      reason: String(item.reason || 'not-collected'),
      impact: DEGRADE_IMPACT.diagnostic,
      ...(item.dropped != null ? { dropped: Number(item.dropped) || 0 } : {}),
    });
  }
  return out;
}

/**
 * 构建证据/降级报告。
 * @param {{capture?:object|null, budget?:object|null, layers?:object[]|null, graph?:object|null,
 *   relations?:object|null, visual?:object[]|null, axNodes?:object[]|null, frames?:object|null,
 *   billing?:object|null, gate?:object|null, zorder?:object|null, issues?:object[]|null,
 *   fallback?:string|null, limits?:object}} [input]
 */
export function buildEvidenceReport(input = {}) {
  const limits = { ...EVIDENCE_LIMITS, ...(input.limits && typeof input.limits === 'object' ? input.limits : {}) };
  const maxDegradations = limitOf(limits.degradations, EVIDENCE_LIMITS.degradations, 500);
  const maxMissing = limitOf(limits.missing, EVIDENCE_LIMITS.missing, 200);
  const capture = input.capture && typeof input.capture === 'object' ? input.capture : null;
  const budget = input.budget && typeof input.budget === 'object' ? input.budget : null;
  const graph = input.graph && typeof input.graph === 'object' ? input.graph : null;
  const relations = input.relations && typeof input.relations === 'object' ? input.relations : null;
  const frames = input.frames && typeof input.frames === 'object' ? input.frames : null;
  const layers = Array.isArray(input.layers) ? input.layers : null;
  const visual = Array.isArray(input.visual) ? input.visual : null;
  const axNodes = Array.isArray(input.axNodes) ? input.axNodes : null;

  const evidence = {
    capture: captureEvidence(capture),
    budget: budget
      ? evidenceEntry('budget', { available: true, source: 'vom-budget', counts: { active: budget.active === true, reason: budget.reason || null } })
      : evidenceEntry('budget', { available: false, reason: 'not-collected', impact: DEGRADE_IMPACT.diagnostic }),
    layers: layers && layers.length
      ? evidenceEntry('layers', { available: true, source: 'layer-facts', counts: { layers: layers.length } })
      : evidenceEntry('layers', { available: false, reason: 'not-collected', impact: DEGRADE_IMPACT.correctness }),
    geometry: graph && graph.counts && Number(graph.counts.nodes) > 0
      ? evidenceEntry('geometry', { available: true, source: 'vom-graph', counts: { nodes: Number(graph.counts.nodes) || 0 }, truncated: graph.truncated === true })
      : evidenceEntry('geometry', { available: false, reason: 'upstream-unavailable', impact: DEGRADE_IMPACT.correctness }),
    relations: relations && Number(relations.stats && relations.stats.relations) >= 0
      ? evidenceEntry('relations', {
        available: true,
        source: 'vom-relations',
        counts: { relations: Number(relations.stats.relations) || 0, byType: relations.stats.byType ? { ...relations.stats.byType } : {} },
        truncated: relations.stats.truncated === true,
      })
      : evidenceEntry('relations', { available: false, reason: 'upstream-unavailable', impact: DEGRADE_IMPACT.correctness }),
    visual: visual && visual.length
      ? evidenceEntry('visual', { available: true, source: 'visual-scan', counts: { objects: visual.length } })
      : evidenceEntry('visual', { available: false, reason: 'not-collected', impact: DEGRADE_IMPACT.diagnostic }),
    ax: axNodes && axNodes.length
      ? evidenceEntry('ax', { available: true, source: 'ax-tree', counts: { nodes: axNodes.length } })
      : evidenceEntry('ax', { available: false, reason: 'not-requested', impact: DEGRADE_IMPACT.diagnostic }),
    frames: frames
      ? evidenceEntry('frames', {
        available: true,
        source: 'frame-vom',
        counts: { frames: Number(frames.frames) || 0, hidden: Number(frames.hidden) || 0 },
        truncated: frames.truncated === true,
      })
      : evidenceEntry('frames', { available: false, reason: 'not-multi-frame', impact: DEGRADE_IMPACT.diagnostic }),
    billing: input.billing && Number.isFinite(Number(input.billing.totalTokens))
      ? evidenceEntry('billing', { available: true, source: 'vom-billing', counts: { tokens: Number(input.billing.totalTokens) || 0 } })
      : evidenceEntry('billing', { available: false, reason: 'not-collected', impact: DEGRADE_IMPACT.diagnostic }),
    zorder: input.zorder && typeof input.zorder === 'object'
      ? evidenceEntry('zorder', { available: input.zorder.available === true, source: 'vom-zorder', counts: { ...(input.zorder.counts || {}) }, truncated: input.zorder.truncated === true })
      : evidenceEntry('zorder', { available: false, reason: 'not-collected', impact: DEGRADE_IMPACT.diagnostic }),
  };
  if (!evidence.zorder.available && evidence.zorder.reason === 'not-collected') {
    // zorder 缺失通常意味着没有层/几何：把原因降级为兼容目标不可用，便于调用方定位。
    evidence.zorder.reason = 'upstream-unavailable';
  }

  const budgets = budgetEntries(budget, graph);
  const degradations = []
    .concat(stageDegradations(capture, maxDegradations))
    .concat(budgetDegradations(budgets, maxDegradations))
    .concat(gateDegradations(input.gate, maxDegradations));
  if (input.fallback) {
    degradations.push({
      code: DEGRADE_CODES.fallback,
      stage: 'observe',
      reason: String(input.fallback).slice(0, 80),
      count: 1,
      impact: DEGRADE_IMPACT.recall,
      evidence: { fallback: String(input.fallback).slice(0, 80) },
    });
  }
  if (graph && graph.truncated === true) {
    degradations.push({ code: DEGRADE_CODES.truncated, stage: 'relations', reason: 'graph-truncated', count: 1, impact: DEGRADE_IMPACT.recall, evidence: { counts: graph.counts || null } });
  }
  if (relations && relations.stats && relations.stats.truncated === true) {
    degradations.push({ code: DEGRADE_CODES.truncated, stage: 'relations', reason: 'relation-limit', count: 1, impact: DEGRADE_IMPACT.recall, evidence: { relations: Number(relations.stats.relations) || 0 } });
  }
  if (relations && relations.integrity && relations.integrity.ok === false) {
    degradations.push({
      code: DEGRADE_CODES.relationIntegrity,
      stage: 'relations',
      reason: 'relation-integrity',
      count: Object.values(relations.integrity.counts || {}).reduce((sum, value) => sum + (Number(value) || 0), 0),
      impact: DEGRADE_IMPACT.correctness,
      evidence: { counts: relations.integrity.counts || null },
    });
  }
  if (frames && Number(frames.hidden) > 0) {
    degradations.push({ code: DEGRADE_CODES.frameGap, stage: 'frames', reason: 'hidden-frame', count: Number(frames.hidden) || 0, impact: DEGRADE_IMPACT.recall, evidence: { gaps: frames.gaps || null } });
  }
  if (frames && Number(frames.unlinked) > 0) {
    degradations.push({ code: DEGRADE_CODES.frameGap, stage: 'frames', reason: 'frame-unlinked', count: Number(frames.unlinked) || 0, impact: DEGRADE_IMPACT.correctness, evidence: null });
  }
  const visualBlocked = input.visualBlocked && typeof input.visualBlocked === 'object' ? input.visualBlocked : null;
  if (visualBlocked) {
    for (const [reason, raw] of Object.entries(visualBlocked)) {
      if (degradations.length >= maxDegradations) break;
      const count = Number(raw) || 0;
      if (count <= 0) continue;
      degradations.push({ code: DEGRADE_CODES.visualBlocked, stage: 'visual', reason, count, impact: DEGRADE_IMPACT.diagnostic, evidence: null });
    }
  }
  for (const issue of Array.isArray(input.issues) ? input.issues : []) {
    if (degradations.length >= maxDegradations) break;
    degradations.push({
      code: DEGRADE_CODES.stageIssue,
      stage: String((issue && issue.stage) || 'unknown'),
      reason: String((issue && issue.reason) || 'issue').slice(0, 160),
      count: 1,
      impact: DEGRADE_IMPACT.diagnostic,
      evidence: null,
    });
  }
  const missing = [];
  const pushMissing = (item) => {
    if (missing.length >= maxMissing) return;
    missing.push(item);
  };
  for (const kind of EVIDENCE_KINDS) {
    const entry = evidence[kind];
    if (entry && entry.available !== true) pushMissing({ evidence: kind, reason: entry.reason || 'not-collected', impact: entry.impact || DEGRADE_IMPACT.diagnostic });
  }
  for (const item of zorderMissing(input.zorder, maxMissing)) pushMissing(item);
  if (!budgets.length) pushMissing({ evidence: 'budget', reason: 'budget-report-absent', impact: DEGRADE_IMPACT.diagnostic });

  const availableKinds = EVIDENCE_KINDS.filter((kind) => evidence[kind] && evidence[kind].available === true);
  const requiredPresent = REQUIRED_EVIDENCE.filter((kind) => evidence[kind] && evidence[kind].available === true);
  const warningCount = degradations.filter((item) => item.impact === DEGRADE_IMPACT.correctness).length;
  const recallCount = degradations.filter((item) => item.impact === DEGRADE_IMPACT.recall).length;
  const diagnosticCount = degradations.filter((item) => item.impact === DEGRADE_IMPACT.diagnostic).length;
  return {
    version: VOM_EVIDENCE_VERSION,
    available: availableKinds.length > 0,
    complete: requiredPresent.length === REQUIRED_EVIDENCE.length && warningCount === 0,
    // score：证据覆盖（种类）+ 事实正确性权重，0..1；不把“降级”算成失败，只作为可解释分数。
    score: Math.round((
      (availableKinds.length / EVIDENCE_KINDS.length) * 0.5
      + (requiredPresent.length / REQUIRED_EVIDENCE.length) * 0.5
    ) * 1000) / 1000,
    evidence,
    budgets: budgets.slice(0, limitOf(limits.budgets, EVIDENCE_LIMITS.budgets, 20)),
    degradations: degradations.slice(0, maxDegradations),
    missing,
    counts: {
      evidence: availableKinds.length,
      expected: EVIDENCE_KINDS.length,
      required: requiredPresent.length,
      degradations: degradations.length,
      correctness: warningCount,
      recall: recallCount,
      diagnostic: diagnosticCount,
      missing: missing.length,
    },
    limits: { degradations: maxDegradations, missing: maxMissing },
  };
}

/** JSON 安全摘要（observe 的 vomEvidence；degradations 已限量）。 */
export function summarizeEvidence(report, options = {}) {
  if (!report || typeof report !== 'object') {
    return {
      version: VOM_EVIDENCE_VERSION,
      available: false,
      complete: false,
      score: 0,
      evidence: {},
      budgets: [],
      degradations: [],
      missing: [{ evidence: 'report', reason: 'not-built', impact: 'diagnostic' }],
      counts: {},
    };
  }
  const maxDegradations = limitOf(options.degradations, 16, 100);
  const maxMissing = limitOf(options.missing, 12, 100);
  return {
    version: report.version || VOM_EVIDENCE_VERSION,
    available: report.available === true,
    complete: report.complete === true,
    score: numberOrNull(report.score) === null ? 0 : Number(report.score),
    evidence: report.evidence && typeof report.evidence === 'object' ? { ...report.evidence } : {},
    budgets: Array.isArray(report.budgets) ? report.budgets.slice(0, 8) : [],
    degradations: (Array.isArray(report.degradations) ? report.degradations : []).slice(0, maxDegradations),
    missing: (Array.isArray(report.missing) ? report.missing : []).slice(0, maxMissing),
    counts: { ...(report.counts || {}) },
  };
}

/** 一行诊断文本（observe 的 vomEvidenceText）。 */
export function describeEvidence(summary) {
  if (!summary || typeof summary !== 'object') return '';
  const counts = summary.counts || {};
  const parts = ['evidence ' + (counts.evidence || 0) + '/' + (counts.expected || 0) + ' score=' + (summary.score || 0)];
  if (summary.complete === true) parts.push('complete');
  if (Number(counts.correctness) > 0) parts.push('correctness=' + Number(counts.correctness));
  if (Number(counts.recall) > 0) parts.push('recall=' + Number(counts.recall));
  if (Number(counts.missing) > 0) parts.push('missing=' + Number(counts.missing));
  const reasons = (Array.isArray(summary.missing) ? summary.missing : []).slice(0, 4).map((item) => item.evidence + ':' + item.reason);
  if (reasons.length) parts.push('[' + reasons.join(', ') + ']');
  return parts.join(' ');
}

/** 把若干份证据报告合并（例如跨帧多份 → 一份总报告）。 */
export function mergeEvidenceReports(reports) {
  const list = (Array.isArray(reports) ? reports : []).filter((report) => report && typeof report === 'object');
  if (!list.length) return null;
  const degradations = [];
  const missing = [];
  const budgets = [];
  const evidence = {};
  for (const report of list) {
    for (const item of Array.isArray(report.degradations) ? report.degradations : []) degradations.push(item);
    for (const item of Array.isArray(report.missing) ? report.missing : []) missing.push(item);
    for (const item of Array.isArray(report.budgets) ? report.budgets : []) budgets.push(item);
    for (const [kind, entry] of Object.entries(report.evidence || {})) {
      const existing = evidence[kind];
      if (!existing || (existing.available !== true && entry && entry.available === true)) evidence[kind] = entry;
    }
  }
  const availableKinds = Object.keys(evidence).filter((kind) => evidence[kind] && evidence[kind].available === true);
  return {
    version: VOM_EVIDENCE_VERSION,
    available: availableKinds.length > 0,
    complete: list.every((report) => report.complete === true),
    score: Math.round((list.reduce((sum, report) => sum + (Number(report.score) || 0), 0) / list.length) * 1000) / 1000,
    evidence,
    budgets,
    degradations: degradations.slice(0, EVIDENCE_LIMITS.degradations),
    missing: missing.slice(0, EVIDENCE_LIMITS.missing),
    counts: {
      evidence: availableKinds.length,
      expected: EVIDENCE_KINDS.length,
      required: REQUIRED_EVIDENCE.filter((kind) => evidence[kind] && evidence[kind].available === true).length,
      degradations: degradations.length,
      correctness: degradations.filter((item) => item.impact === DEGRADE_IMPACT.correctness).length,
      recall: degradations.filter((item) => item.impact === DEGRADE_IMPACT.recall).length,
      diagnostic: degradations.filter((item) => item.impact === DEGRADE_IMPACT.diagnostic).length,
      missing: missing.length,
    },
    reports: list.length,
  };
}

export function evidenceVersion() {
  return VOM_EVIDENCE_VERSION;
}
