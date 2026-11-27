// VOM 预算：node/token/group/top 裁剪、固定输出形状、默认计费口径不变。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VOM_BUDGET_REASONS,
  VOM_BUDGET_VERSION,
  applySemanticBudget,
  budgetCostOf,
  buildVomBudgetReport,
  evaluateVomBudget,
  normalizeVomBudget,
  summarizeVomBudget,
  trimVomGroups,
} from '../../extension/src/lib/vom-budget.js';
import { estimateVomTokens } from '../../extension/src/lib/vom-weights.js';
import { buildVomSemanticGraph } from '../../extension/src/lib/vom-semantic.js';

function node(id, name, role = 'button') {
  return { id, name, role };
}

test('normalizeVomBudget：上限归一化，负数/NaN 视为无上限', () => {
  assert.equal(VOM_BUDGET_VERSION, 1);
  assert.deepEqual(normalizeVomBudget({ maxNodes: 10, maxTokens: 500, top: 5, maxGroups: 3, groupTokens: 100 }), {
    version: 1, nodes: 10, tokens: 500, top: 5, groups: 3, groupTokens: 100, active: true,
  });
  assert.equal(normalizeVomBudget({}).active, false);
  const negative = normalizeVomBudget({ maxNodes: -5, maxTokens: 'abc' });
  assert.equal(negative.nodes, 0);
  assert.equal(negative.tokens, 0);
  // 扁平 nodes/tokens 等价于 maxNodes/maxTokens（observe 的 vomBudget 支持两种写法）。
  assert.equal(normalizeVomBudget({ nodes: 4, tokens: 200 }).nodes, 4);
  assert.equal(normalizeVomBudget({ nodes: 4, tokens: 200 }).tokens, 200);
});

test('预算成本与既有计费口径一致（name+role，不引入新 tokenizer）', () => {
  const sample = { id: 'a', name: '提交', role: 'button', tag: 'button' };
  assert.equal(budgetCostOf(sample), estimateVomTokens(sample));
  assert.equal(budgetCostOf(sample), 12);
  assert.equal(budgetCostOf({ name: '', role: '' }), 8);
});

test('evaluateVomBudget：节点上限确定性裁剪 + 理由', () => {
  const nodes = [node('a', 'aa'), node('b', 'bb'), node('c', 'cc')];
  const result = evaluateVomBudget(nodes, { maxNodes: 2 });
  assert.deepEqual(result.nodes.map((item) => item.id), ['a', 'b']);
  assert.equal(result.kept, 2);
  assert.deepEqual(result.budget, { nodes: 2, tokens: 0 });
  assert.equal(result.used.nodes, 2);
  assert.equal(result.trimmed.nodes, 1);
  assert.equal(result.reason, 'node-limit');
  assert.equal(result.reasons['node-limit'], 1);
  assert.equal(result.active, true);
  assert.deepEqual(result.drops.map((item) => item.reason), ['node-limit']);
});

test('evaluateVomBudget：token 上限在成本超限处丢弃，不重排', () => {
  const nodes = [node('a', 'aa'), node('b', 'bb'), node('c', 'cc')];
  const cost = estimateVomTokens(nodes[0]);
  const result = evaluateVomBudget(nodes, { maxTokens: cost * 2 });
  assert.deepEqual(result.nodes.map((item) => item.id), ['a', 'b']);
  assert.equal(result.reason, 'token-limit');
  assert.equal(result.trimmed.tokens, estimateVomTokens(nodes[2]));
  const noLimit = evaluateVomBudget(nodes, {});
  assert.equal(noLimit.nodes.length, 3);
  assert.equal(noLimit.reason, VOM_BUDGET_REASONS.none);
  assert.equal(noLimit.active, false);
});

test('buildVomBudgetReport：固定形状 {budget,used,trimmed,reason} + top 裁剪', () => {
  const nodes = [node('a', 'aa'), node('b', 'bb'), node('c', 'cc'), node('d', 'dd')];
  const report = buildVomBudgetReport({ nodes, nodeBudget: { maxNodes: 3, maxTokens: 100 }, top: 2 });
  assert.equal(report.version, 1);
  assert.deepEqual(report.budget, { nodes: 3, tokens: 100, groups: 0, groupTokens: 0 });
  assert.deepEqual(report.used, { nodes: 2, tokens: estimateVomTokens(nodes[0]) + estimateVomTokens(nodes[1]) });
  assert.deepEqual(report.trimmed, { groups: 0, nodes: 2, tokens: report.trimmed.tokens, top: 1 });
  assert.equal(report.trimmed.top, 1);
  assert.equal(report.reason, 'node-limit');
  assert.deepEqual(report.nodes.map((item) => item.id), ['a', 'b']);
  // top 单独触发时 reason=top-limit。
  const topOnly = buildVomBudgetReport({ nodes, top: 3 });
  assert.equal(topOnly.reason, 'top-limit');
  assert.deepEqual(topOnly.nodes.map((item) => item.id), ['a', 'b', 'c']);
  assert.equal(topOnly.trimmed.top, 1);
  assert.equal(topOnly.trimmed.groups, 0);
  // groupTrim 记入 trimmed.groups。
  const withGroups = buildVomBudgetReport({ nodes, groupTrim: { dropped: 2 } });
  assert.equal(withGroups.trimmed.groups, 2);
  assert.equal(withGroups.reason, 'group-limit');
});

test('trimVomGroups：组数上限与组 token 上限', () => {
  const groups = [
    { id: 'g1', tokens: 10, memberIds: ['@e1', '@e2'] },
    { id: 'g2', tokens: 20, memberIds: ['@e3'] },
    { id: 'g3', tokens: 30, memberIds: ['@e4'] },
  ];
  const byCount = trimVomGroups(groups, { maxGroups: 2 });
  assert.deepEqual(byCount.groups.map((group) => group.id), ['g1', 'g2']);
  assert.equal(byCount.trimmed.groups, 1);
  assert.equal(byCount.reason, 'group-limit');
  assert.equal(byCount.used.tokens, 30);
  const byTokens = trimVomGroups(groups, { maxTokens: 25 });
  assert.deepEqual(byTokens.groups.map((group) => group.id), ['g1']);
  assert.equal(byTokens.reason, 'token-limit');
  assert.equal(byTokens.trimmed.groups, 2);
  const none = trimVomGroups(groups, {});
  assert.equal(none.kept, 3);
  assert.equal(none.active, false);
  assert.deepEqual(groups.map((group) => group.id), ['g1', 'g2', 'g3'], 'trimVomGroups 不应修改输入');
});

test('applySemanticBudget：复用既有组过滤并给出组裁剪计数', () => {
  const entries = [
    { id: 'a', node: { role: 'textbox', name: 'A', ancestors: [{ tag: 'form', id: 'f1' }], vomScore: 30 } },
    { id: 'b', node: { role: 'textbox', name: 'B', ancestors: [{ tag: 'form', id: 'f1' }], vomScore: 20 } },
    { id: 'c', node: { role: 'link', name: 'C', ancestors: [{ tag: 'nav', id: 'n1' }], vomScore: 5 } },
  ];
  const graph = buildVomSemanticGraph(entries);
  assert.equal(graph.nodes.length, 2);
  const filtered = applySemanticBudget(entries, graph, { maxGroups: 1 });
  assert.equal(filtered.totalGroups, 2);
  assert.equal(filtered.keptGroups, 1);
  assert.equal(filtered.groupsDropped, 1);
  assert.equal(filtered.reason, 'group-limit');
  assert.ok(filtered.ids.has('a') && filtered.ids.has('b'));
  assert.equal(applySemanticBudget(entries, graph, {}), null, '未给组预算时返回 null，调用方跳过');
});

test('summarizeVomBudget 输出单行诊断', () => {
  const text = summarizeVomBudget(buildVomBudgetReport({ nodes: [node('a', 'aa')], nodeBudget: { maxNodes: 5, maxTokens: 100 } }));
  assert.match(text, /budget nodes=5 tokens=100/);
  assert.match(text, /used=1\/\d+/);
  assert.match(text, /reason=none/);
  assert.equal(summarizeVomBudget(null), '');
});
