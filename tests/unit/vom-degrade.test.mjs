// VOM 证据/降级报告：预算（token/节点/分组/边）、阶段丢弃、缺失证据、完整性评分。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEGRADE_CODES,
  DEGRADE_IMPACT,
  EVIDENCE_KINDS,
  REQUIRED_EVIDENCE,
  VOM_EVIDENCE_VERSION,
  buildEvidenceReport,
  describeEvidence,
  mergeEvidenceReports,
  summarizeEvidence,
} from '../../extension/src/lib/vom-degrade.js';

function fullInput() {
  return {
    capture: {
      stages: [
        { name: 'collect', input: 10, output: 8, dropped: 2, dropReasons: [{ reason: 'hidden', count: 2 }] },
        { name: 'resolve', input: 8, output: 8, dropped: 0, dropReasons: [] },
        { name: 'filter', input: 8, output: 6, dropped: 2, dropReasons: [{ reason: 'paint-hidden', count: 2 }] },
        { name: 'enrich', input: 6, output: 6, dropped: 0, dropReasons: [] },
        { name: 'rank', input: 6, output: 6, dropped: 0, dropReasons: [] },
        { name: 'emit', input: 6, output: 5, dropped: 1, dropReasons: [{ reason: 'node-limit', count: 1 }] },
      ],
    },
    budget: {
      version: 1,
      budget: { nodes: 5, tokens: 100, groups: 2 },
      used: { nodes: 4, tokens: 60, groups: 1 },
      trimmed: { nodes: 1, tokens: 40, groups: 1 },
      reason: 'node-limit',
      active: true,
    },
    layers: [{ level: 'L2', role: 'dialog', name: '确认' }],
    graph: { counts: { nodes: 4, edges: 3, byType: { child: 3 } }, truncated: true, limit: { nodes: 600, edges: 1500 } },
    relations: { stats: { relations: 5, byType: { contains: 2, controls: 1 }, truncated: false } },
    visual: [{ kind: 'ref', ref: '@e1' }],
    axNodes: [{ nodeId: 1 }, { nodeId: 2 }],
    billing: { totalTokens: 60 },
    gate: { mode: 'paintable', byReason: { 'paint-hidden': 2 } },
    zorder: { available: true, counts: { stack: 3, chains: 1 }, missing: [], truncated: false },
    issues: [{ stage: 'facts', reason: 'snapshot-failed' }],
    fallback: 'ax',
    visualBlocked: { 'no-action-target': 1 },
  };
}

test('完整证据：evidence 覆盖 9/10、预算条目齐全、降级按 impact 分类', () => {
  const report = buildEvidenceReport(fullInput());
  assert.equal(report.version, VOM_EVIDENCE_VERSION);
  assert.equal(report.available, true);
  assert.equal(report.complete, true, '必填证据齐全且无 correctness 级降级');
  assert.equal(report.score, 0.95, 'frames 缺失只扣覆盖分');
  for (const kind of ['capture', 'budget', 'layers', 'geometry', 'relations', 'visual', 'ax', 'billing', 'zorder']) {
    assert.equal(report.evidence[kind].available, true, kind + ' 应可用');
  }
  assert.equal(report.evidence.frames.available, false);
  assert.equal(report.evidence.frames.reason, 'not-multi-frame');
  for (const kind of REQUIRED_EVIDENCE) assert.equal(report.evidence[kind].available, true);
  assert.deepEqual(report.budgets.map((entry) => entry.kind), ['nodes', 'tokens', 'groups', 'edges']);
  const nodesBudget = report.budgets.find((entry) => entry.kind === 'nodes');
  assert.equal(nodesBudget.limit, 5);
  assert.equal(nodesBudget.used, 4);
  assert.equal(nodesBudget.trimmed, 1);
  assert.equal(report.budgets.find((entry) => entry.kind === 'edges').trimmed, 1);
  const codes = report.degradations.map((item) => item.code);
  assert.ok(codes.includes(DEGRADE_CODES.captureDropped), 'capture 丢弃应被记录');
  assert.ok(codes.filter((code) => code === DEGRADE_CODES.budgetTrimmed).length >= 3);
  assert.ok(codes.includes(DEGRADE_CODES.gateDropped));
  assert.ok(codes.includes(DEGRADE_CODES.fallback));
  assert.ok(codes.includes(DEGRADE_CODES.truncated));
  assert.ok(codes.includes(DEGRADE_CODES.stageIssue));
  assert.ok(codes.includes(DEGRADE_CODES.visualBlocked));
  assert.equal(report.counts.correctness, 0);
  assert.ok(report.counts.recall >= 5);
  assert.ok(report.counts.diagnostic >= 2);
  assert.ok(EVIDENCE_KINDS.includes('zorder'));
  assert.equal(DEGRADE_IMPACT.correctness, 'correctness');
});

test('缺证据：structurally 标 missing/correctness，complete=false 且不伪造', () => {
  const report = buildEvidenceReport({ graph: { counts: { nodes: 1, edges: 0 }, truncated: false } });
  assert.equal(report.available, true);
  assert.equal(report.complete, false);
  assert.ok(report.score < 1);
  const layerMissing = report.missing.find((item) => item.evidence === 'layers');
  assert.ok(layerMissing, '缺 layers 应进入 missing');
  assert.equal(layerMissing.impact, DEGRADE_IMPACT.correctness);
  assert.equal(report.evidence.layers.available, false);
  assert.equal(report.evidence.layers.reason, 'not-collected');
  assert.equal(report.evidence.visual.available, false);
  assert.equal(report.evidence.zorder.reason, 'upstream-unavailable', 'zorder 缺失归因到上游');
  const empty = buildEvidenceReport();
  assert.equal(empty.available, false);
  assert.equal(empty.complete, false);
  assert.equal(empty.score, 0);
  for (const kind of EVIDENCE_KINDS) assert.equal(empty.evidence[kind].available, false);
});

test('zorder 缺失清单与关系完整性降级', () => {
  const report = buildEvidenceReport({
    graph: { counts: { nodes: 2, edges: 1 }, truncated: false },
    layers: [{ role: 'dialog' }],
    relations: {
      stats: { relations: 2, truncated: true },
      integrity: { ok: false, counts: { dangling: 1, duplicates: 0, cycles: 1 } },
    },
    zorder: {
      available: false,
      counts: { stack: 0 },
      missing: [{ evidence: 'geometry', reason: 'geometry-missing', dropped: 2 }],
    },
  });
  const missingZorder = report.missing.find((item) => item.evidence === 'geometry' && item.reason === 'geometry-missing');
  assert.ok(missingZorder);
  assert.equal(missingZorder.dropped, 2);
  assert.equal(missingZorder.impact, DEGRADE_IMPACT.diagnostic);
  const integrity = report.degradations.find((item) => item.code === DEGRADE_CODES.relationIntegrity);
  assert.ok(integrity);
  assert.equal(integrity.count, 2);
  assert.equal(integrity.impact, DEGRADE_IMPACT.correctness);
  assert.equal(report.complete, false);
  assert.ok(report.counts.correctness >= 1);
});

test('mergeEvidenceReports：跨帧多份报告合并，complete 取与、evidence 取可用优先', () => {
  const main = buildEvidenceReport(fullInput());
  const child = buildEvidenceReport({
    graph: { counts: { nodes: 1, edges: 0 }, truncated: false },
    layers: [],
    relations: { stats: { relations: 0 } },
  });
  const merged = mergeEvidenceReports([main, child]);
  assert.equal(merged.reports, 2);
  assert.equal(merged.available, true);
  assert.equal(merged.complete, false, '子帧不完整 → 合并后不完整');
  assert.equal(merged.evidence.layers.available, true, '主帧有层则合并层可用');
  assert.ok(merged.counts.degradations >= main.counts.degradations);
  assert.equal(mergeEvidenceReports([]), null);
});

test('summarizeEvidence / describeEvidence：限量、JSON 安全、可读文本', () => {
  const summary = summarizeEvidence(buildEvidenceReport(fullInput()), { degradations: 3, missing: 2 });
  assert.equal(summary.version, VOM_EVIDENCE_VERSION);
  assert.equal(summary.complete, true);
  assert.equal(summary.degradations.length, 3);
  assert.ok(summary.missing.length <= 2);
  assert.ok(summary.evidence.capture.available);
  assert.ok(summary.budgets.length >= 1);
  const roundTrip = JSON.parse(JSON.stringify(summary));
  assert.deepEqual(roundTrip.counts, summary.counts);
  const text = describeEvidence(summary);
  assert.match(text, /evidence \d+\/10/);
  assert.match(text, /score=/);
  assert.match(text, /complete/);
  const emptyText = describeEvidence(summarizeEvidence(null));
  assert.match(emptyText, /evidence 0\/0/);
});
