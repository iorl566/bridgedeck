// 关系图 v3 扩展：labels 链 / html-for / tab-controls / 组合控件 owns / describes(alt,title,describedby)
// / invalidates（aria-errormessage, invalid+describedby, invalid-flag）/ 跨 frame 节点。
// 全部是纯函数单测；真实 DOM 证据见 tests/browser/vom-relations.js。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPOSITE_OWNED_ROLES,
  COMPOSITE_ROLES,
  RELATION_CONFIDENCE,
  RELATION_INVALIDATES,
  RELATION_KINDS,
  RELATION_TYPES,
  VOM_RELATIONS_VERSION,
  buildVomRelationGraph,
  labelChainForNode,
  relationsForNode,
} from '../../extension/src/lib/vom-relations.js';

function fixtureGraph() {
  return {
    nodes: [
      { id: '@e1', domId: 'name', role: 'textbox', tag: 'input' },
      { id: '@e2', domId: 'lbl-name', tag: 'label' },
      { id: '@e3', domId: 'root-label', tag: 'span' },
      { id: '@e4', domId: 'mid-label', tag: 'span' },
      { id: '@e5', domId: 'tab1', role: 'tab', tag: 'button' },
      { id: '@e6', domId: 'panel1', role: 'tabpanel', tag: 'div' },
      { id: '@e7', domId: 'list', role: 'listbox', tag: 'ul' },
      { id: '@e8', domId: 'opt1', role: 'option', tag: 'li' },
      { id: '@e9', domId: 'combo', role: 'combobox', tag: 'div' },
      { id: '@e10', domId: 'err', role: 'alert', tag: 'div' },
      { id: '@e11', domId: 'logo-link', role: 'link', tag: 'a' },
      { id: '@e12', domId: 'logo-img', role: 'img', tag: 'img' },
      { id: '@e13', domId: 'titled', role: 'button', tag: 'button' },
      { id: '@e14', domId: 'desc', role: 'note', tag: 'div' },
    ],
    edges: [
      { type: 'html-for', from: '@e2', to: '@e1' },
      { type: 'tab-controls', from: '@e5', to: '@e6' },
      { type: 'child', from: '@e7', to: '@e8' },
      { type: 'child', from: '@e9', to: '@e7' },
      { type: 'child', from: '@e11', to: '@e12' },
      { type: 'errormessage', from: '@e10', to: '@e1' },
      { type: 'labelledby', from: '@e3', to: '@e4' },
      { type: 'describedby', from: '@e14', to: '@e1' },
    ],
  };
}

function fixtureEntries() {
  return [
    {
      id: '@e1',
      node: {
        id: 'name',
        role: 'textbox',
        tag: 'input',
        name: '姓名',
        title: '请填写姓名',
        invalid: true,
        labelledByChain: [
          { id: 'mid-label', depth: 1, from: null },
          { id: 'root-label', depth: 2, from: 'mid-label' },
        ],
      },
      relations: {
        labelledBy: ['mid-label'],
        describedBy: ['desc'],
        errorMessage: ['err'],
        labelIds: ['lbl-name'],
      },
    },
    { id: '@e11', node: { id: 'logo-link', role: 'link', tag: 'a', name: '返回首页' }, relations: {} },
    { id: '@e12', node: { id: 'logo-img', role: 'img', tag: 'img', alt: '返回首页' }, relations: {} },
    { id: '@e13', node: { id: 'titled', role: 'button', tag: 'button', name: '保存', title: '保存当前草稿' }, relations: {} },
  ];
}

test('关系类型契约：v3 基线五元组不变，kinds 增加 invalidates', () => {
  assert.equal(VOM_RELATIONS_VERSION, 3);
  assert.deepEqual(RELATION_TYPES, ['contains', 'labels', 'controls', 'owns', 'describes']);
  assert.deepEqual(RELATION_KINDS, ['contains', 'labels', 'controls', 'owns', 'describes', 'invalidates']);
  assert.equal(RELATION_INVALIDATES, 'invalidates');
  assert.ok(COMPOSITE_ROLES.includes('listbox') && COMPOSITE_ROLES.includes('combobox'));
  assert.ok(COMPOSITE_OWNED_ROLES.includes('option') && COMPOSITE_OWNED_ROLES.includes('treeitem'));
  const graph = buildVomRelationGraph();
  assert.deepEqual(graph.relationTypes, ['contains', 'labels', 'controls', 'owns', 'describes']);
  assert.deepEqual(graph.kinds, RELATION_KINDS.slice());
  assert.equal(graph.version, 3);
});

test('labels：aria-labelledby 链生成 aria-labelledby-chain 关系并逐跳降低置信度', () => {
  const graph = buildVomRelationGraph({ entries: fixtureEntries(), graph: fixtureGraph() });
  const labels = graph.relations.filter((relation) => relation.type === 'labels');
  const direct = labels.find((relation) => relation.source === 'aria-labelledby' && relation.to === '@e1');
  assert.ok(direct, '缺少 aria-labelledby 直接关系');
  assert.equal(direct.from, '@e4');
  assert.equal(direct.to, '@e1');
  assert.equal(direct.confidence, RELATION_CONFIDENCE['aria-labelledby']);
  const chain = labels.find((relation) => relation.source === 'aria-labelledby-chain');
  assert.ok(chain, '缺少 aria-labelledby-chain 关系');
  assert.equal(chain.from, '@e3');
  assert.equal(chain.to, '@e1');
  assert.equal(chain.depth, 2);
  assert.equal(chain.confidence, 0.9);
  assert.ok(chain.chain.includes('@e3'));
  const htmlFor = labels.find((relation) => relation.source === 'html-for');
  assert.ok(htmlFor, '缺少 html-for 来源的 labels 关系');
  assert.equal(htmlFor.from, '@e2');
  assert.equal(htmlFor.confidence, RELATION_CONFIDENCE['html-for']);
  // 页面 chain 事实优先时不重复生成图推导链。
  assert.equal(labels.filter((relation) => relation.source === 'aria-labelledby-chain').length, 1);
  assert.equal(graph.stats.chainedLabels, 1);
});

test('labels：没有页面 chain 事实时用页面图 labelledby 邻接表推导链', () => {
  const graph = buildVomRelationGraph({
    entries: [{ id: '@in', node: { id: 'input2', role: 'textbox' }, relations: { labelledBy: ['lvl1'] } }],
    graph: {
      nodes: [
        { id: '@in', domId: 'input2', role: 'textbox' },
        { id: '@a', domId: 'lvl1', tag: 'span' },
        { id: '@b', domId: 'lvl2', tag: 'span' },
        { id: '@c', domId: 'lvl3', tag: 'span' },
      ],
      edges: [
        { type: 'labelledby', from: '@b', to: '@a' },
        { type: 'labelledby', from: '@c', to: '@b' },
      ],
    },
  });
  const chain = graph.relations.filter((relation) => relation.source === 'aria-labelledby-chain');
  assert.equal(chain.length, 2, '两跳链应生成两条关系：' + JSON.stringify(chain));
  const depth2 = chain.find((relation) => relation.to === '@in' && relation.from === '@b');
  const depth3 = chain.find((relation) => relation.to === '@in' && relation.from === '@c');
  assert.ok(depth2 && depth3);
  assert.equal(depth2.depth, 2);
  assert.equal(depth3.depth, 3);
  assert.ok(depth3.confidence < depth2.confidence, '链越深置信度应越低');
  assert.ok(depth3.confidence >= 0.5);
});

test('controls：tab 的 aria-controls 走 tab-controls 来源', () => {
  const graph = buildVomRelationGraph({ graph: fixtureGraph() });
  const controls = graph.relations.filter((relation) => relation.type === 'controls');
  assert.equal(controls.length, 1);
  assert.equal(controls[0].from, '@e5');
  assert.equal(controls[0].to, '@e6');
  assert.equal(controls[0].source, 'tab-controls');
  assert.equal(controls[0].confidence, RELATION_CONFIDENCE['tab-controls']);
  assert.equal(graph.stats.byType.controls, 1);
});

test('owns：组合控件 listbox→option 生成 composite-owner', () => {
  const graph = buildVomRelationGraph({ graph: fixtureGraph() });
  const owns = graph.relations.filter((relation) => relation.type === 'owns');
  const composite = owns.find((relation) => relation.source === 'composite-owner');
  assert.ok(composite, '缺少 composite-owner owns 关系');
  assert.equal(composite.from, '@e7');
  assert.equal(composite.to, '@e8');
  assert.equal(composite.composite, 'listbox');
  assert.equal(composite.confidence, RELATION_CONFIDENCE['composite-owner']);
  // combobox→listbox 不是“被拥有子项”，不应产生 owns 关系。
  assert.equal(owns.some((relation) => relation.from === '@e9' && relation.to === '@e7' && relation.source === 'composite-owner'), false);
  assert.equal(graph.stats.compositeOwns, 1);
});

test('owns：页面图没有子边时用 entry 祖先链兜底组合控件归属', () => {
  const entries = [
    { id: '@list', node: { id: 'list1', role: 'listbox', tag: 'ul' }, relations: {} },
    {
      id: '@opt',
      node: { id: 'opt1', role: 'option', tag: 'li', ancestors: [{ role: 'listbox', id: 'list1' }] },
      relations: {},
    },
  ];
  const graph = buildVomRelationGraph({ entries });
  const owns = graph.relations.find((relation) => relation.source === 'composite-owner');
  assert.ok(owns, '祖先兜底未生成 composite-owner');
  assert.equal(owns.from, '@list');
  assert.equal(owns.to, '@opt');
});

test('describes：aria-describedby 带描述文本证据，alt 描述命名它的链接，title 形成自描述', () => {
  const graph = buildVomRelationGraph({ entries: fixtureEntries(), graph: fixtureGraph() });
  const describes = graph.relations.filter((relation) => relation.type === 'describes');
  const describedBy = describes.find((relation) => relation.source === 'aria-describedby');
  assert.ok(describedBy, '缺少 aria-describedby describes 关系');
  assert.equal(describedBy.from, '@e14');
  assert.equal(describedBy.to, '@e1');
  assert.equal(describedBy.confidence, RELATION_CONFIDENCE['aria-describedby']);
  const alt = describes.find((relation) => relation.source === 'alt-text' && relation.from === '@e12');
  assert.ok(alt, '缺少 alt-text describes 关系');
  assert.equal(alt.to, '@e11');
  assert.equal(alt.text, '返回首页');
  assert.equal(alt.via, 'alt');
  const titles = describes.filter((relation) => relation.source === 'title-attribute');
  assert.equal(titles.length, 2, '两个带 title 的节点应各有一条自描述：' + JSON.stringify(titles.map((item) => item.from)));
  const title = titles.find((relation) => relation.from === '@e13');
  assert.equal(title.to, '@e13');
  assert.equal(title.self, true);
  assert.equal(title.via, 'title');
  assert.equal(title.text, '保存当前草稿');
  assert.equal(graph.stats.selfDescriptions, 2);
});

test('describes：img 没有命名外部控件时退化为 alt 自描述', () => {
  const entries = [
    { id: '@img', node: { id: 'solo', role: 'img', tag: 'img', alt: '示意图' }, relations: {} },
  ];
  const graph = buildVomRelationGraph({ entries });
  const alt = graph.relations.find((relation) => relation.source === 'alt-text');
  assert.ok(alt);
  assert.equal(alt.from, '@img');
  assert.equal(alt.to, '@img');
  assert.equal(alt.self, true);
  assert.equal(alt.text, '示意图');
});

test('invalidates：aria-errormessage 边方向反转 + invalid describedby 合并来源', () => {
  const graph = buildVomRelationGraph({ entries: fixtureEntries(), graph: fixtureGraph() });
  const invalidates = graph.relations.filter((relation) => relation.type === 'invalidates');
  const fromError = invalidates.find((relation) => relation.from === '@e10' && relation.to === '@e1');
  assert.ok(fromError, '缺少 错误消息→控件 的 invalidates 关系');
  assert.equal(fromError.confidence, RELATION_CONFIDENCE['aria-errormessage']);
  assert.ok(fromError.sources.includes('aria-errormessage'), '来源=' + JSON.stringify(fromError.sources));
  assert.ok(fromError.sources.includes('invalid-describedby'), 'invalid describedby 未与 errormessage 合并：' + JSON.stringify(fromError.sources));
  const fromDesc = invalidates.find((relation) => relation.from === '@e14' && relation.to === '@e1');
  assert.ok(fromDesc, '缺少 describedby 错误文案的 invalidates 关系');
  assert.equal(fromDesc.source, 'invalid-describedby');
  assert.equal(fromDesc.state, 'invalid');
  assert.equal(invalidates.some((relation) => relation.self === true), false, '有错误目标时不应再退化自关系');
  assert.equal(graph.stats.byType.invalidates, 2);
});

test('invalidates：invalid 且无错误目标时退化为自身 invalid-flag 关系', () => {
  const graph = buildVomRelationGraph({
    entries: [{ id: '@bad', node: { id: 'bad', role: 'textbox', invalid: true }, relations: {} }],
  });
  const relation = graph.relations.find((item) => item.type === 'invalidates');
  assert.ok(relation);
  assert.equal(relation.from, '@bad');
  assert.equal(relation.to, '@bad');
  assert.equal(relation.self, true);
  assert.equal(relation.source, 'invalid-flag');
  assert.equal(relation.state, 'invalid');
  assert.equal(relation.confidence, RELATION_CONFIDENCE['invalid-flag']);
});

test('端点角色补充：关系记录带 fromRole/toRole 供查询过滤', () => {
  const graph = buildVomRelationGraph({ entries: fixtureEntries(), graph: fixtureGraph() });
  const description = graph.relations.find((relation) => relation.source === 'aria-describedby');
  assert.equal(description.fromRole, 'note');
  assert.equal(description.toRole, 'textbox');
  const composite = graph.relations.find((relation) => relation.source === 'composite-owner');
  assert.equal(composite.fromRole, 'listbox');
  assert.equal(composite.toRole, 'option');
});

test('labelChainForNode：按深度排序返回链上证据', () => {
  const graph = buildVomRelationGraph({ entries: fixtureEntries(), graph: fixtureGraph() });
  const chain = labelChainForNode(graph, '@e1');
  assert.equal(chain.length, 3, 'html-for + labelledby + chain = 3：' + JSON.stringify(chain));
  assert.deepEqual(chain.map((item) => item.depth), [1, 1, 2]);
  assert.equal(chain[2].source, 'aria-labelledby-chain');
  assert.deepEqual(labelChainForNode(graph, '@missing'), []);
  assert.deepEqual(labelChainForNode(null, '@e1'), []);
});

test('relationsForNode：自描述/入出方向兼容', () => {
  const graph = buildVomRelationGraph({ entries: fixtureEntries(), graph: fixtureGraph() });
  const self = relationsForNode(graph, '@e13').filter((relation) => relation.self === true);
  assert.equal(self.length, 1);
  assert.equal(self[0].type, 'describes');
  const forInput = relationsForNode(graph, '@e1');
  assert.ok(forInput.some((relation) => relation.type === 'labels' && relation.direction === 'in'));
  assert.ok(forInput.some((relation) => relation.type === 'invalidates' && relation.direction === 'in'));
});

test('跨 frame：frames 输入让 frame 节点参与 contains/owns 关系', () => {
  const frames = [
    {
      frameId: 0,
      url: 'https://example.test/',
      vom: {
        available: true,
        frameNodeId: 'frame:0',
        nodes: [
          { id: 'frame:0', tag: 'document', role: 'document', frame: true, frameId: 0 },
          { id: 'f0:@e1', tag: 'iframe', role: null, parentId: 'frame:0' },
          { id: 'f0:@e2', tag: 'div', role: null },
        ],
        edges: [
          { type: 'frame', from: 'frame:0', to: 'f0:@e2' },
          { type: 'frame', from: 'f0:@e1', to: 'frame:1' },
        ],
        roots: ['f0:@e2'],
      },
    },
    {
      frameId: 1,
      parentFrameId: 0,
      url: 'https://example.test/child',
      vom: {
        available: true,
        frameNodeId: 'frame:1',
        nodes: [{ id: 'frame:1', tag: 'iframe', role: 'frame', frame: true, frameId: 1 }],
        edges: [],
        roots: [],
      },
    },
  ];
  const graph = buildVomRelationGraph({ frames });
  assert.equal(graph.frames.length, 2);
  assert.equal(graph.frameStats.relations >= 3, true, 'frame 关系数=' + graph.frameStats.relations);
  const contains = graph.relations.filter((relation) => relation.type === 'contains' && relation.frame === true);
  assert.ok(contains.some((relation) => relation.from === 'frame:0' && relation.to === 'f0:@e2' && relation.source === 'frame-edge'));
  assert.ok(contains.some((relation) => relation.from === 'frame:0' && relation.to === 'frame:1' && relation.source === 'parent-frame'));
  const owns = graph.relations.find((relation) => relation.type === 'owns' && relation.frame === true);
  assert.ok(owns, '缺少 iframe 元素 → 子帧节点的 frame-owner owns 关系');
  assert.equal(owns.from, 'f0:@e1');
  assert.equal(owns.to, 'frame:1');
  assert.equal(owns.source, 'frame-owner');
  assert.ok(graph.stats.frameRelations >= 3);
  // 不给 frames 时 frame 边仍被忽略（既有行为不回退）。
  const plain = buildVomRelationGraph({ graph: { nodes: [{ id: '@a' }, { id: '@b' }], edges: [{ type: 'frame', from: '@a', to: '@b' }] } });
  assert.deepEqual(plain.relations, []);
  assert.deepEqual(plain.frames, []);
});

test('limits：关系数上限触发 truncated，且端点去重稳定', () => {
  const nodes = [{ id: '@c', domId: 'c', role: 'tablist', tag: 'div' }];
  const edges = [];
  for (let index = 0; index < 12; index += 1) {
    nodes.push({ id: '@t' + index, domId: 'tab' + index, role: 'tab', tag: 'button' });
    edges.push({ type: 'tab-controls', from: '@t' + index, to: '@c' });
  }
  const graph = buildVomRelationGraph({ graph: { nodes, edges }, limits: { relations: 3 } });
  assert.equal(graph.relations.length, 3);
  assert.equal(graph.stats.truncated, true);
  assert.equal(new Set(graph.relations.map((relation) => relation.from + '>' + relation.to)).size, 3);
});

test('场景回归：既有 graphFixture 的 6 条关系与置信度保持不变', () => {
  const graph = buildVomRelationGraph({
    graph: {
      nodes: [
        { id: '@e1', domId: 'btn', tag: 'button', role: 'button' },
        { id: '@e2', domId: 'dlg', tag: 'div', role: 'dialog' },
        { id: '@e3', domId: 'lbl', tag: 'label', role: null },
        { id: '@e4', domId: 'panel', tag: 'div', role: 'menu' },
        { id: '@e5', domId: 'owner', tag: 'div', role: null },
        { id: '@e6', domId: 'form1', tag: 'form', role: 'form' },
      ],
      edges: [
        { type: 'controls', from: '@e1', to: '@e4' },
        { type: 'label', from: '@e3', to: '@e1' },
        { type: 'describedby', from: '@e3', to: '@e1' },
        { type: 'owns', from: '@e5', to: '@e1' },
        { type: 'form', from: '@e6', to: '@e1' },
        { type: 'child', from: '@e6', to: '@e1' },
        { type: 'frame', from: '@e1', to: '@e2' },
      ],
    },
  });
  assert.equal(graph.relations.length, 6);
  assert.equal(graph.stats.lowConfidence, 1);
  assert.equal(graph.relations.some((relation) => relation.type === 'invalidates'), false);
});
