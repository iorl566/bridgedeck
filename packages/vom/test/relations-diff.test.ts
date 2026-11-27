// packages/vom/test/relations-diff.test.ts —— 语义关系图 v3 JS ↔ TS 差分测试。
//
// 覆盖边界：空/非对象输入、显式 ARIA 关系（controls/labelledBy/describedBy/labelIds/owns/
// form/errorMessage）、页面图 11 类 edge 映射、组合控件推导、labelledby 链（页面侧 chain 事实
// 与邻接表推导两条路径）、invalidates 三种形态、img alt/title 描述、语义组 contains 与组上下文、
// 跨 frame 合并、四类 limits 截断、以及重复来源合并/异常事实。
//
// 除逐字段 deepEqual 外，还断言输出自身的不变量（type 合法、confidence ∈ [0,1]、sources 非空、
// 三元组唯一、stats 与 relations 自洽），避免“两边一起错”也能过。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPOSITE_ROLES,
  RELATION_CONFIDENCE,
  RELATION_KINDS,
  RELATION_TYPES,
  SELF_RELATION_TYPES,
  VOM_RELATIONS_VERSION,
  buildVomRelationGraph,
  filterRelationsByConfidence,
  labelChainForNode,
  relationsForNode,
} from '../src/index.ts';
import type {
  BuildVomRelationGraphInput,
  VomRelationGraph,
} from '../src/index.ts';

const js: any = await import('../../../extension/src/lib/vom-relations.js');

/** 测试夹具允许任意页面事实（运行期数据不可信，类型只约束调用方）。 */
function asInput(value: unknown): BuildVomRelationGraphInput {
  return value as BuildVomRelationGraphInput;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 一个观测条目（可选带 relations / ancestorIds）。 */
function entry(
  id: string,
  node: Record<string, unknown> | null,
  relations?: Record<string, unknown>,
  ancestorIds?: readonly unknown[],
): Record<string, unknown> {
  return {
    id,
    node,
    ...(relations ? { relations } : {}),
    ...(ancestorIds ? { ancestorIds } : {}),
  };
}

/** 页面侧常用：domId（node.id）→ 关系图节点 id。 */
const DOM: readonly Record<string, unknown>[] = [
  entry('@e1', { id: 'txt', role: 'textbox', name: 'Username', tag: 'input' }),
  entry('@e2', { id: 'lbl', role: 'label', name: '用户名' }),
  entry('@e3', { id: 'panel', role: 'region', name: '帮助面板' }),
  entry('@e4', { id: 'hint', role: 'note', name: '至少 8 位' }),
  entry('@e5', { id: 'lab', role: 'label', name: '用户' }),
  entry('@e6', { id: 'opt', role: 'option', name: '选项 A', tag: 'li' }),
  entry('@e7', { id: 'f1', role: 'form', name: '登录' }),
  entry('@e8', { id: 'err', role: 'alert', name: '用户名已存在' }),
  entry('@e9', { id: 'lbl2', role: 'label', name: '账号' }),
];

/** 页面图节点（role/domId/parentId 可与 entry 事实不同，关系层优先取 entry）。 */
function gnode(id: string, role: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, role, ...extra };
}

function gedge(type: string, from: string, to: string): Record<string, unknown> {
  return { type, from, to };
}

const CASES: readonly { label: string; input: unknown }[] = [
  { label: '空输入', input: {} },
  { label: 'undefined', input: undefined },
  { label: '非对象输入', input: 'not-an-object' },
  {
    label: 'entries 非数组 + graph/semantic 非对象',
    input: { entries: 'nope', graph: [], semantic: 'x', frames: null, limits: 'nope' },
  },
  {
    label: '仅 entries 的显式 ARIA 关系',
    input: {
      entries: [
        entry('@e1', { id: 'txt', role: 'textbox', name: 'Username', tag: 'input' }, {
          labelledBy: ['lbl', 'lbl2', ''],
          controls: ['panel', 'missing'],
          describedBy: ['hint'],
          labelIds: ['lab'],
          owns: ['opt'],
          form: ['f1'],
          errorMessage: ['err'],
        }),
        ...DOM.slice(1),
      ],
    },
  },
  {
    label: '页面图 11 类 edge 映射',
    input: {
      entries: [
        entry('@a', { id: 'a', role: 'button', name: '按钮' }),
        entry('@b', { id: 'b', role: 'region', name: '面板' }),
      ],
      graph: {
        nodes: [gnode('@a', 'button'), gnode('@b', 'region'), gnode('@c', 'textbox', { domId: 'c' })],
        edges: [
          gedge('controls', '@a', '@b'),
          gedge('tab-controls', '@a', '@b'),
          gedge('label', '@b', '@a'),
          gedge('html-for', '@b', '@a'),
          gedge('labelledby', '@b', '@a'),
          gedge('describedby', '@c', '@a'),
          gedge('owns', '@a', '@c'),
          gedge('form', '@b', '@a'),
          gedge('child', '@b', '@c'),
          gedge('errormessage', '@c', '@a'),
          gedge('frame', '@a', 'frame:0'),
          gedge('unknown-edge', '@a', '@b'),
          gedge('', '@a', '@b'),
        ],
      },
    },
  },
  {
    label: '组合控件 child 边 → composite-owner',
    input: {
      entries: [
        entry('@list', { id: 'list', role: 'LISTBOX', name: '城市' }),
        entry('@o1', { id: 'o1', role: 'Option', name: '北京', tag: 'li' }),
        entry('@o2', { id: 'o2', role: 'option', name: '上海', tag: 'li' }),
        entry('@menu', { id: 'menu', role: 'menu', name: '菜单' }),
        entry('@mi', { id: 'mi', role: 'menuitem', name: '复制' }),
      ],
      graph: {
        nodes: [
          gnode('@list', 'listbox'),
          gnode('@o1', 'option'),
          gnode('@o2', 'option'),
          gnode('@menu', 'menu'),
          gnode('@mi', 'menuitem'),
        ],
        edges: [
          gedge('child', '@list', '@o1'),
          gedge('child', '@list', '@o2'),
          gedge('child', '@menu', '@mi'),
        ],
      },
    },
  },
  {
    label: 'labelledby 链：页面侧 chain 事实',
    input: {
      entries: [
        entry('@e1', {
          id: 'txt',
          role: 'textbox',
          name: '账号',
          labelledByChain: [
            { id: 'lbl', depth: 2, chain: ['txt', 'lbl'] },
            { id: 'lbl2', depth: 3, chain: ['txt', 'lbl', 'lbl2'], from: 'lbl' },
            { id: 'lbl3', depth: 1, chain: ['txt', 'lbl3'] },
          ],
        }),
        ...DOM.slice(1),
      ],
    },
  },
  {
    label: 'labelledby 链：邻接表推导',
    input: {
      entries: [
        entry('@e1', { id: 'txt' }, { labelledBy: ['lbl'] }),
        entry('@e2', { id: 'lbl' }, { labelledBy: ['lbl2', 'lbl3'] }),
        entry('@e9', { id: 'lbl2' }, { labelledBy: ['lbl3'] }),
        entry('@e10', { id: 'lbl3' }, { labelledBy: ['lbl'] }),
      ],
    },
  },
  {
    label: 'invalidates：errormessage / describedby / 无目标自指',
    input: {
      entries: [
        entry('@e1', { id: 'txt', role: 'textbox', name: 'Email', invalid: true }, {
          errorMessage: ['err'],
          describedBy: ['hint'],
        }),
        entry('@e2', { id: 'txt2', role: 'textbox', name: 'Phone', invalid: true }, { describedBy: ['hint'] }),
        entry('@e3', { id: 'txt3', role: 'textbox', name: 'Name', invalid: true }),
        entry('@e8', { id: 'err', role: 'alert', name: '邮箱格式错误' }),
        entry('@e4', { id: 'hint', role: 'note', name: '必填' }),
      ],
    },
  },
  {
    label: 'img alt 连父控件 / title 自描述 / 无链接 alt',
    input: {
      entries: [
        entry('@link', { id: 'link', role: 'link', name: '了解更多关于产品的说明' }),
        entry('@img1', { id: 'img1', role: 'img', alt: '了解更多关于产品的说明' }),
        entry('@img2', { id: 'img2', tag: 'img', alt: '公司 Logo' }),
        entry('@btn', { id: 'btn', role: 'button', name: '提交' }),
        entry('@img3', { id: 'img3', tag: 'img', alt: '提交' }),
        entry('@img4', { id: 'img4', tag: 'img', alt: '' }),
        entry('@titled', { id: 'titled', role: 'note', title: '  说明文字  ' }),
        entry('@titled2', { id: 'titled2', role: 'note', title: '' }),
      ],
      graph: {
        nodes: [gnode('@link', 'link'), gnode('@img1', 'img'), gnode('@btn', 'button'), gnode('@img3', 'img')],
        edges: [
          gedge('child', '@link', '@img1'),
          gedge('child', '@btn', '@img3'),
        ],
      },
    },
  },
  {
    label: '语义组 contains → 组上下文/父子',
    input: {
      entries: [entry('@e1', { id: 'txt', role: 'textbox', name: 'Username' })],
      semantic: {
        nodes: [
          { id: 'g1', groupKind: 'section', members: 3, tokens: 40, score: 1.2 },
          { id: 'g2', groupKind: 'table', members: 2, tokens: 30 },
          { id: 'g3', groupKind: 'form', members: 5 },
          { id: 'g4' },
          { id: null },
        ],
        edges: [
          { type: 'contains', from: 'g1', to: 'g2', fromKind: 'section', toKind: 'table' },
          { type: 'contains', from: 'g1', to: 'g3' },
          { type: 'contains', from: 'g2', to: 'g4' },
          { type: 'contains', from: 'g4', to: 'g1' },
          { type: 'sibling', from: 'g1', to: 'g4' },
        ],
      },
    },
  },
  {
    label: '跨 frame 合并（frame 节点作为端点）',
    input: {
      entries: [entry('@e1', { id: 'txt', role: 'textbox', name: 'Username' })],
      frames: {
        graphs: [
          {
            frameId: 0,
            url: 'https://example.test/',
            graph: {
              nodes: [{ id: 'frame:0', role: 'document' }, { id: '@e1', role: 'textbox' }],
              roots: ['@e1'],
              edges: [],
            },
          },
          {
            frameId: 3,
            parentFrameId: 0,
            graph: {
              nodes: [{ id: 'frame:3', role: 'frame', url: 'https://example.test/f' }, { id: '@f3a', role: 'button' }],
              roots: ['@f3a'],
              edges: [{ type: 'frame', from: 'frame:0', to: 'frame:3' }],
            },
          },
        ],
      },
    },
  },
  {
    label: 'limits 截断（relations/groups/contexts/chainDepth）',
    input: {
      entries: [
        entry('@e1', { id: 'txt' }, { labelledBy: ['lbl'] }),
        entry('@e2', { id: 'lbl' }, { labelledBy: ['lbl2'] }),
        entry('@e9', { id: 'lbl2' }, { labelledBy: ['lbl3'] }),
        entry('@e10', { id: 'lbl3' }, { labelledBy: ['lbl4'] }),
        entry('@e11', { id: 'lbl4' }),
      ],
      semantic: {
        nodes: [{ id: 'g1', groupKind: 'section', members: 1 }, { id: 'g2', groupKind: 'section' }],
        edges: [{ type: 'contains', from: 'g1', to: 'g2' }],
      },
      limits: { relations: 2, groups: 1, contexts: 1, chainDepth: 1, bogus: 9 },
    },
  },
  {
    label: '重复来源合并（html-for + aria-labelledby 取最大置信度）',
    input: {
      entries: [
        entry('@e1', { id: 'txt', role: 'textbox' }, { labelledBy: ['lbl'] }),
        entry('@e2', { id: 'lbl', role: 'label', name: '用户名' }),
      ],
      graph: {
        nodes: [gnode('@e1', 'textbox'), gnode('@e2', 'label')],
        edges: [
          gedge('html-for', '@e2', '@e1'),
          gedge('label', '@e2', '@e1'),
          gedge('labelledby', '@e2', '@e1'),
        ],
      },
    },
  },
  {
    label: '异常事实：空 id / 数字 id / 空值字段 / 自环',
    input: {
      entries: [
        entry('', { id: 'x' }),
        entry('0', { id: 0, role: 42, tag: null, name: 123 }, { controls: 42, labelledBy: ['', null, 'x'], describedBy: {} }),
        entry('@self', { id: 'self', role: 'textbox', invalid: true }),
        { id: '@nonode' },
        { id: '@badrel', node: {}, relations: { controls: { a: 1 }, owns: ['@self'] } },
      ],
      graph: {
        nodes: [{ id: '@self', role: null }, { id: null }, null],
        edges: [
          { type: 'controls', from: null, to: '@self' },
          { type: 'controls', from: '@self', to: '@self' },
          { type: 'child', from: '@self' },
        ],
      },
      semantic: { nodes: 'nope', edges: [{ type: 'contains', from: null, to: null }] },
    },
  },
  {
    label: '大图上限：controls 关系被 600 截断',
    input: {
      entries: Array.from({ length: 650 }, (_, index) => entry('@n' + index, { id: 'n' + index, role: 'button', name: '按钮 ' + index }, {
        controls: ['n' + ((index + 1) % 650)],
      })),
    },
  },
];

/** 构建一张 TS 图，并给出同一输入的 JS 图。 */
function buildPair(value: unknown): { tsGraph: VomRelationGraph; jsGraph: any } {
  const inputValue = value === undefined ? {} : value;
  return { tsGraph: buildVomRelationGraph(asInput(inputValue)), jsGraph: js.buildVomRelationGraph(inputValue) };
}

function nodeIdsOf(graph: VomRelationGraph): string[] {
  const ids = new Set<string>();
  for (const relation of graph.relations) {
    ids.add(relation.from);
    ids.add(relation.to);
  }
  return [...ids];
}

test('buildVomRelationGraph：全部用例逐字段相等', () => {
  for (const { label, input } of CASES) {
    const { tsGraph, jsGraph } = buildPair(input);
    assert.deepEqual(clone(tsGraph), clone(jsGraph), label + ' 的关系图不一致');
  }
});

test('relationsForNode：每个端点的视图逐字段相等', () => {
  for (const { label, input } of CASES) {
    const { tsGraph, jsGraph } = buildPair(input);
    for (const nodeId of [...nodeIdsOf(tsGraph), 'missing', '', null, 0, '@e1']) {
      assert.deepEqual(
        clone(relationsForNode(tsGraph, nodeId)),
        clone(js.relationsForNode(jsGraph, nodeId)),
        label + ' / 节点 ' + String(nodeId) + ' 的 relationsForNode 不一致',
      );
    }
  }
});

test('labelChainForNode：每个端点按 depth 排序后逐字段相等', () => {
  for (const { label, input } of CASES) {
    const { tsGraph, jsGraph } = buildPair(input);
    for (const nodeId of [...nodeIdsOf(tsGraph), 'missing', undefined]) {
      assert.deepEqual(
        clone(labelChainForNode(tsGraph, nodeId)),
        clone(js.labelChainForNode(jsGraph, nodeId)),
        label + ' / 节点 ' + String(nodeId) + ' 的 labelChainForNode 不一致',
      );
    }
  }
});

test('filterRelationsByConfidence：多阈值过滤逐字段相等且不改原图', () => {
  const thresholds: readonly (number | string | null | undefined)[] = [0.7, 0.9, 1, 0, -1, '0.8', null, undefined, 'x'];
  for (const { label, input } of CASES) {
    const { tsGraph, jsGraph } = buildPair(input);
    const snapshot = clone(tsGraph);
    for (const threshold of thresholds) {
      assert.deepEqual(
        clone(filterRelationsByConfidence(tsGraph, threshold)),
        clone(js.filterRelationsByConfidence(jsGraph, threshold)),
        label + ' / 阈值 ' + String(threshold) + ' 的过滤结果不一致',
      );
    }
    assert.deepEqual(clone(tsGraph), snapshot, label + ' 的过滤修改了原图');
  }
  // 非图输入原样返回（与 JS 一致）。
  assert.equal(filterRelationsByConfidence(null), js.filterRelationsByConfidence(null));
  assert.deepEqual(
    clone(filterRelationsByConfidence({} as unknown as VomRelationGraph)),
    clone(js.filterRelationsByConfidence({})),
  );
});

test('输出不变量：类型合法、confidence ∈ [0,1]、sources 非空、三元组唯一、stats 自洽', () => {
  for (const { label, input } of CASES) {
    const graph = buildVomRelationGraph(asInput(input));
    assert.equal(graph.version, VOM_RELATIONS_VERSION, label + ' 版本不符');
    assert.deepEqual(clone(graph.relationTypes), clone(RELATION_TYPES), label + ' relationTypes 契约被改');
    assert.deepEqual(clone(graph.kinds), clone(RELATION_KINDS), label + ' kinds 契约被改');
    const seen = new Set<string>();
    for (const relation of graph.relations) {
      assert.ok(RELATION_KINDS.includes(relation.type), label + ' 非法关系类型：' + relation.type);
      assert.ok(relation.confidence >= 0 && relation.confidence <= 1, label + ' confidence 越界：' + relation.confidence);
      assert.ok(relation.sources.length >= 1, label + ' sources 为空');
      assert.ok(relation.sources.includes(relation.source as never), label + ' source 不在 sources 里');
      const key = relation.type + '|' + relation.from + '|' + relation.to;
      assert.ok(!seen.has(key), label + ' 三元组重复：' + key);
      seen.add(key);
      if (relation.from === relation.to) {
        assert.ok(SELF_RELATION_TYPES.includes(relation.type as never), label + ' 非自指类型出现自环：' + relation.type);
        assert.equal(relation.self, true, label + ' 自环必须标 self');
      }
    }
    const relationCount = graph.relations.length;
    assert.equal(graph.stats.relations, relationCount, label + ' stats.relations 与关系数不符');
    assert.equal(
      Object.values(graph.stats.byType).reduce((sum, count) => sum + count, 0),
      graph.stats.relations,
      label + ' stats.byType 合计与关系数不符',
    );
    assert.equal(
      Object.values(graph.stats.bySource).reduce((sum, count) => sum + count, 0),
      graph.relations.reduce((sum, relation) => sum + relation.sources.length, 0),
      label + ' stats.bySource 合计与来源数不符',
    );
    assert.equal(graph.stats.groups, graph.groups.length, label + ' stats.groups 与组数不符');
    assert.equal(graph.stats.contexts, graph.contexts.length, label + ' stats.contexts 与上下文数不符');
  }
});

test('关键语义硬断言（不依赖 JS 对照）', () => {
  const labelled = buildVomRelationGraph(asInput({
    entries: [
      entry('@e1', { id: 'txt', role: 'textbox' }, { labelledBy: ['lbl'], controls: ['panel'] }),
      entry('@e2', { id: 'lbl', role: 'label', name: '用户名' }),
      entry('@e3', { id: 'panel', role: 'region' }),
      entry('@e4', { id: 'tab', role: 'tab' }, { controls: ['panel'] }),
    ],
  }));
  const labelRelation = labelled.relations.find((relation) => relation.type === 'labels');
  assert.equal(labelRelation?.from, '@e2');
  assert.equal(labelRelation?.to, '@e1');
  assert.equal(labelRelation?.confidence, RELATION_CONFIDENCE['aria-labelledby']);
  const tabControls = labelled.relations.find((relation) => relation.source === 'tab-controls');
  assert.equal(tabControls?.confidence, RELATION_CONFIDENCE['tab-controls']);
  assert.equal(tabControls?.from, '@e4');

  // 组合控件：listbox→option 由 child 边推导，composite 字段记录父角色。
  const composite = buildVomRelationGraph(asInput({
    entries: [
      entry('@list', { id: 'list', role: 'listbox' }),
      entry('@o1', { id: 'o1', role: 'option' }),
    ],
    graph: { nodes: [gnode('@list', 'listbox'), gnode('@o1', 'option')], edges: [gedge('child', '@list', '@o1')] },
  }));
  const owns = composite.relations.find((relation) => relation.source === 'composite-owner');
  assert.equal(owns?.from, '@list');
  assert.equal(owns?.to, '@o1');
  assert.equal(owns?.composite, 'listbox');
  assert.equal(owns?.confidence, 0.8);
  assert.ok(COMPOSITE_ROLES.includes('listbox'));

  // invalid 自指：没有错误文案时退化为 invalid-flag 自关系（entry 需带 relations 对象才进入该分支）。
  const invalid = buildVomRelationGraph(asInput({
    entries: [entry('@e1', { id: 'txt', role: 'textbox', invalid: true }, {})],
  }));
  assert.deepEqual(clone(invalid.relations), [{
    type: 'invalidates',
    from: '@e1',
    to: '@e1',
    confidence: 0.8,
    source: 'invalid-flag',
    sources: ['invalid-flag'],
    self: true,
    state: 'invalid',
    fromRole: 'textbox',
    toRole: 'textbox',
  }]);

  // labelledby 链：depth 越大置信度越低（下限 0.5）。
  const chain = buildVomRelationGraph(asInput({
    entries: [
      entry('@e1', { id: 'txt' }, { labelledBy: ['lbl'] }),
      entry('@e2', { id: 'lbl' }, { labelledBy: ['lbl2'] }),
      entry('@e9', { id: 'lbl2' }, { labelledBy: ['lbl3'] }),
      entry('@e10', { id: 'lbl3' }, { labelledBy: ['lbl4'] }),
    ],
  }));
  const chained = chain.relations.filter((relation) => relation.source === 'aria-labelledby-chain');
  const chainedToRoot = chained.filter((relation) => relation.to === '@e1');
  assert.ok(chainedToRoot.length >= 2, '邻接表推导应从根节点产出多条链关系');
  for (const relation of chainedToRoot) {
    assert.ok((relation.depth ?? 0) >= 2, '链深度必须 ≥ 2');
    assert.ok(relation.confidence >= 0.5 && relation.confidence <= 0.9);
    assert.ok(Array.isArray(relation.chain) && (relation.chain ?? []).length >= 2);
  }
  const rootLabels = chain.relations.filter((relation) => relation.type === 'labels' && relation.to === '@e1');
  assert.deepEqual(
    rootLabels.length,
    new Set(rootLabels.map((relation) => relation.from)).size,
    '同一目标上每个标签节点只出现一次',
  );

  // 空输入永远是合法的空图。
  assert.deepEqual(clone(buildVomRelationGraph()), {
    version: 3,
    relationTypes: ['contains', 'labels', 'controls', 'owns', 'describes'],
    kinds: ['contains', 'labels', 'controls', 'owns', 'describes', 'invalidates'],
    relations: [],
    groups: [],
    contexts: [],
    frames: [],
    frameStats: null,
    stats: {
      relations: 0,
      nodes: 0,
      byType: {},
      bySource: {},
      lowConfidence: 0,
      averageConfidence: 0,
      groups: 0,
      contextGroups: 0,
      contexts: 0,
      truncated: false,
      selfRelations: 0,
      selfDescriptions: 0,
      chainedLabels: 0,
      invalidates: 0,
      compositeOwns: 0,
      frameRelations: 0,
    },
  });
});

test('limits：relations/groups/contexts 严格截断并置 truncated', () => {
  const capped = buildVomRelationGraph(asInput(CASES.find((item) => item.label === 'limits 截断（relations/groups/contexts/chainDepth）')?.input));
  assert.ok(capped.relations.length <= 2, 'relations 上限 2 未生效：' + capped.relations.length);
  assert.ok(capped.groups.length <= 1, 'groups 上限 1 未生效：' + capped.groups.length);
  assert.ok(capped.contexts.length <= 1, 'contexts 上限 1 未生效：' + capped.contexts.length);
  assert.equal(capped.stats.truncated, true);

  const big = buildVomRelationGraph(asInput(CASES.find((item) => item.label === '大图上限：controls 关系被 600 截断')?.input));
  assert.equal(big.relations.length, 600, '默认 relations 上限应为 600');
  assert.equal(big.stats.truncated, true);
});

test('跨 frame：frames/frameStats 由 frame-relations 提供且端点可查', () => {
  const input = CASES.find((item) => item.label === '跨 frame 合并（frame 节点作为端点）')?.input;
  const graph = buildVomRelationGraph(asInput(input));
  assert.equal(graph.frames.length, 2);
  assert.deepEqual(graph.frames.map((frame) => frame.frameId), [0, 3]);
  assert.ok(graph.frameStats !== null);
  assert.equal(graph.stats.frameRelations, graph.frameStats?.relations);
  const frameIds = new Set(graph.relations.map((relation) => relation.from));
  assert.ok(frameIds.has('frame:0'), 'frame:0 应作为关系端点出现');
  const frameEdge = graph.relations.find((relation) => relation.source === 'frame-edge');
  assert.ok(frameEdge, '缺少 frame-edge 关系');
  assert.equal(frameEdge?.frame, true);
  assert.equal(frameEdge?.confidence, RELATION_CONFIDENCE['frame-edge']);
  assert.equal(graph.stats.relations, graph.relations.length);
});

test('根输入 null：JS 与 TS 都按同一契约抛错（不是静默返回空图）', () => {
  assert.throws(() => js.buildVomRelationGraph(null));
  assert.throws(() => buildVomRelationGraph(null as unknown as BuildVomRelationGraphInput));
});
