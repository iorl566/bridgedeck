// VOM relations 全链：containment / ownership / labels / controls / describes / invalidates
// + 路径查询 + 完整性（悬空/重复/环/未知类型）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAIN_TYPES,
  VOM_RELATION_CHAIN_VERSION,
  buildRelationChains,
  buildRelationIndex,
  buildOwnershipPath,
  checkRelationChainIntegrity,
  describeRelationChains,
  findRelationPaths,
  normalizeRelationGraph,
  resolveRelationChain,
  summarizeRelationChains,
} from '../../extension/src/lib/vom-relations-chain.js';

const rel = (type, from, to, extra = {}) => ({ type, from, to, confidence: 0.9, source: 'test', ...extra });

function sampleGraph() {
  return {
    version: 3,
    relations: [
      rel('contains', 'form', 'fieldset'),
      rel('contains', 'fieldset', 'input'),
      rel('owns', 'listbox', 'option'),
      rel('labels', 'label', 'input'),
      rel('labels', 'label2', 'label', { depth: 2, chain: ['label2', 'label', 'input'] }),
      rel('controls', 'tab', 'panel'),
      rel('describes', 'help', 'input'),
      rel('describes', 'input', 'input', { self: true }),
      rel('invalidates', 'error-msg', 'input'),
    ],
  };
}

const nodes = [
  { id: 'form', role: 'form', name: '登录表单', tag: 'form' },
  { id: 'fieldset', role: 'group', name: '账号', tag: 'fieldset' },
  { id: 'input', role: 'textbox', name: '用户名', tag: 'input' },
  { id: 'listbox', role: 'listbox', name: '城市', tag: 'div' },
  { id: 'option', role: 'option', name: '北京', tag: 'div' },
  { id: 'tab', role: 'tab', name: '概览', tag: 'button' },
  { id: 'panel', role: 'tabpanel', name: '概览面板', tag: 'div' },
];

test('normalizeRelationGraph：去重/丢无效端点，非自属性类型禁止自环', () => {
  const graph = {
    relations: [
      rel('contains', 'a', 'b'),
      rel('contains', 'a', 'b'),
      rel('contains', '', 'b'),
      rel('contains', 'a', 'a'),
      rel('describes', 'a', 'a', { self: true }),
      { type: 'contains', from: 'x' },
      null,
    ],
  };
  const normalized = normalizeRelationGraph(graph);
  assert.equal(normalized.version, VOM_RELATION_CHAIN_VERSION);
  assert.equal(normalized.links.length, 2);
  assert.equal(normalized.dropped, 5);
  assert.ok(normalized.truncated);
  assert.equal(normalized.sourceVersion, null);
  assert.deepEqual(normalized.links.map((link) => link.type + ':' + link.from + '>' + link.to), ['contains:a>b', 'describes:a>a']);
});

test('resolveRelationChain：contains/owns/labels/controls/describes 各自方向', () => {
  const index = buildRelationIndex(sampleGraph());
  const contains = resolveRelationChain(index, 'input', 'contains');
  assert.equal(contains.direction, 'in');
  assert.deepEqual(contains.steps.map((step) => step.id), ['fieldset', 'form']);
  assert.equal(contains.reached, 2);
  assert.equal(contains.endId, 'form');

  const labels = resolveRelationChain(index, 'input', 'labels');
  assert.equal(labels.steps[0].id, 'label', 'label2 置信度相同但排序稳定，先到 label');
  assert.ok(labels.steps.every((step) => step.type === 'labels'));

  const controls = resolveRelationChain(index, 'tab', 'controls');
  assert.equal(controls.direction, 'out');
  assert.deepEqual(controls.steps.map((step) => step.id), ['panel']);

  const describes = resolveRelationChain(index, 'input', 'describes');
  assert.deepEqual(describes.steps.map((step) => step.id), ['help']);

  const invalidates = resolveRelationChain(index, 'input', 'invalidates');
  assert.deepEqual(invalidates.steps.map((step) => step.id), ['error-msg']);

  const ownership = buildOwnershipPath(index, 'option');
  assert.deepEqual(ownership.owners.map((step) => step.id), ['listbox']);
  assert.ok(Array.isArray(ownership.path));
});

test('buildRelationChains：每节点全链 + 元数据 + 计数，深度受限', () => {
  const report = buildRelationChains(sampleGraph(), { nodes });
  assert.equal(report.version, VOM_RELATION_CHAIN_VERSION);
  assert.equal(report.available, true);
  assert.equal(report.counts.links, 9);
  assert.equal(report.counts.types, 6);
  assert.ok(report.counts.chained >= 3);
  const input = report.nodes.find((entry) => entry.id === 'input');
  assert.ok(input);
  assert.equal(input.role, 'textbox');
  assert.equal(input.name, '用户名');
  assert.deepEqual(input.contains.map((step) => step.id), ['fieldset', 'form']);
  assert.deepEqual(input.labels.map((step) => step.id), ['label', 'label2']);
  assert.deepEqual(input.describes.map((step) => step.id), ['help']);
  assert.equal(input.controls.length, 0, 'input 不控制任何面板');
  const option = report.nodes.find((entry) => entry.id === 'option');
  assert.deepEqual(option.owns.map((step) => step.id), ['listbox']);
  assert.ok(input.edges.incoming >= 5);
  const shallow = buildRelationChains(sampleGraph(), { nodes, limits: { depth: 1 } });
  const shallowInput = shallow.nodes.find((entry) => entry.id === 'input');
  assert.equal(shallowInput.contains.length, 1, 'depth=1 只走一跳');
  const explicit = buildRelationChains(sampleGraph(), { nodes, ids: ['option'] });
  assert.equal(explicit.nodes.length, 1);
  assert.equal(explicit.nodes[0].id, 'option');
});

test('findRelationPaths：双向遍历，路径步骤带方向与来源', () => {
  const direct = findRelationPaths(sampleGraph(), { from: 'input', to: 'form' });
  assert.equal(direct.available, true);
  assert.ok(direct.paths.length >= 1);
  const first = direct.paths[0];
  assert.equal(first.length, 2);
  assert.deepEqual(first.steps.map((step) => step.type), ['contains', 'contains']);
  assert.ok(first.steps.every((step) => step.direction === 'in'));
  assert.ok(first.steps.every((step) => step.confidence === 0.9));
  // 交叉类型路径：label2 → label → input
  const cross = findRelationPaths(sampleGraph(), { from: 'label2', to: 'input' });
  assert.ok(cross.paths.length >= 1);
  assert.deepEqual(cross.paths[0].steps.map((step) => step.type), ['labels', 'labels']);
  // 自反与不可能路径
  assert.deepEqual(findRelationPaths(sampleGraph(), { from: 'input', to: 'input' }).paths, [{ length: 0, steps: [] }]);
  const empty = findRelationPaths(sampleGraph(), { from: 'input', to: 'nope' });
  assert.equal(empty.paths.length, 0);
  const limited = findRelationPaths(sampleGraph(), { from: 'input', to: 'form', types: ['labels'] });
  assert.equal(limited.paths.length, 0, '类型过滤后 contains 路径不可用');
});

test('checkRelationChainIntegrity：悬空端点 / 重复 / 未知类型 / 自环 / 环', () => {
  const graph = {
    relations: [
      rel('contains', 'a', 'b'),
      rel('contains', 'b', 'a'),
      { type: 'mystery', from: 'a', to: 'b', confidence: 1, source: 'x' },
      rel('describes', 'a', 'b'),
      rel('describes', 'b', 'a'),
      rel('contains', 'a', 'ghost'),
    ],
  };
  const report = checkRelationChainIntegrity(graph, { knownIds: ['a', 'b'] });
  assert.equal(report.available, true);
  assert.equal(report.ok, false);
  assert.ok(report.counts.cycles >= 1, 'contains a↔b 成环');
  assert.ok(report.counts.dangling >= 1, 'ghost 是悬空端点');
  assert.equal(report.counts.unknownTypes, 1);
  assert.equal(report.counts.duplicates, 0);
  assert.deepEqual(report.dangling[0].missing, ['to']);
  const clean = checkRelationChainIntegrity(sampleGraph());
  assert.equal(clean.counts.dangling, 0);
  assert.equal(clean.counts.unknownTypes, 0);
  assert.equal(clean.counts.selfLoop, 0);
  // self describes 合法，不算自环。
  assert.ok(CHAIN_TYPES.includes('describes'));
});

test('summarizeRelationChains：JSON 安全摘要 + 一行文本', () => {
  const summary = summarizeRelationChains(buildRelationChains(sampleGraph(), { nodes }), { nodes: 3 });
  assert.equal(summary.version, VOM_RELATION_CHAIN_VERSION);
  assert.equal(summary.available, true);
  assert.equal(summary.chains.length, 3);
  assert.ok(summary.integrity && summary.integrity.ok === true);
  const input = summary.chains.find((entry) => entry.id === 'input');
  assert.ok(input);
  assert.ok(input.ownership && Array.isArray(input.ownership.owners));
  const roundTrip = JSON.parse(JSON.stringify(summary));
  assert.deepEqual(roundTrip.counts, summary.counts);
  assert.match(describeRelationChains(summary), /chains nodes=/);
  assert.match(describeRelationChains(summary), /links=9/);
});
