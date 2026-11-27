// 语义上下文/分组：landmark / 表单 / 表格分组、父组链、表格表头事实、跨 frame 归属。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTEXT_LIMITS,
  LANDMARK_BY_TAG,
  TABLE_HEADER_ROLES,
  VOM_CONTEXT_VERSION,
  buildVomContext,
  classifyContextAnchor,
  frameIdOfContextNode,
} from '../../extension/src/lib/vom-context.js';

function fixtureGraph() {
  return {
    nodes: [
      { id: '@main', domId: 'm1', tag: 'main', role: 'main', name: '主区域' },
      { id: '@form', domId: 'f1', tag: 'form', role: 'form' },
      { id: '@table', domId: 't1', tag: 'table', role: 'table' },
      { id: '@row', domId: 'r1', tag: 'tr', role: 'row' },
      { id: '@th', domId: 'h1', tag: 'th', role: 'columnheader', name: '名称' },
      { id: '@td', domId: 'c1', tag: 'td', role: 'cell' },
      { id: '@input', domId: 'i1', tag: 'input', role: 'textbox' },
      { id: '@btn', domId: 'b1', tag: 'button', role: 'button' },
    ],
    edges: [
      { type: 'child', from: '@main', to: '@form' },
      { type: 'child', from: '@form', to: '@table' },
      { type: 'child', from: '@table', to: '@row' },
      { type: 'child', from: '@row', to: '@th' },
      { type: 'child', from: '@row', to: '@td' },
      { type: 'child', from: '@td', to: '@input' },
      { type: 'child', from: '@main', to: '@btn' },
    ],
  };
}

function fixtureEntries() {
  return [
    {
      id: '@input',
      node: {
        id: 'i1',
        role: 'textbox',
        tag: 'input',
        name: '姓名',
        ancestors: [
          { tag: 'td', id: 'c1' },
          { tag: 'tr', id: 'r1' },
          { tag: 'table', id: 't1' },
          { tag: 'form', id: 'f1' },
          { tag: 'main', id: 'm1', name: '主区域' },
        ],
      },
      ancestorIds: ['@td', '@row', '@table', '@form', '@main'],
    },
    {
      id: '@btn',
      node: {
        id: 'b1',
        role: 'button',
        tag: 'button',
        name: '提交',
        ancestors: [{ tag: 'main', id: 'm1', name: '主区域' }],
      },
      ancestorIds: ['@main'],
    },
  ];
}

test('上下文版本与角色分类：landmark/form/table 三类的锚点判定', () => {
  assert.equal(VOM_CONTEXT_VERSION, 1);
  assert.equal(LANDMARK_BY_TAG.nav, 'navigation');
  assert.deepEqual(TABLE_HEADER_ROLES, ['columnheader', 'rowheader']);
  assert.deepEqual(classifyContextAnchor({ role: 'navigation', tag: 'nav' }), {
    kind: 'landmark', groupKind: 'navigation', role: 'navigation', tag: 'nav',
  });
  assert.deepEqual(classifyContextAnchor({ role: 'main', tag: 'main' }), {
    kind: 'landmark', groupKind: 'main', role: 'main', tag: 'main',
  });
  assert.deepEqual(classifyContextAnchor({ tag: 'header' }), {
    kind: 'landmark', groupKind: 'banner', role: null, tag: 'header',
  });
  assert.deepEqual(classifyContextAnchor({ tag: 'form' }), {
    kind: 'form', groupKind: 'form', role: null, tag: 'form',
  });
  assert.equal(classifyContextAnchor({ role: 'group', tag: 'div' }).kind, 'form');
  assert.equal(classifyContextAnchor({ role: 'grid', tag: 'div' }).kind, 'table');
  assert.equal(classifyContextAnchor({ tag: 'table' }).kind, 'table');
  assert.equal(classifyContextAnchor({ role: 'button', tag: 'button' }), null);
  assert.equal(classifyContextAnchor({ tag: 'div' }), null);
  assert.equal(classifyContextAnchor(null), null);
  assert.equal(frameIdOfContextNode('f2:@e7'), 2);
  assert.equal(frameIdOfContextNode('@e7'), null);
  assert.equal(frameIdOfContextNode('frame:3'), null);
});

test('landmark/form/table 分组：父组链 + 每节点上下文（近 → 远）', () => {
  const context = buildVomContext({ entries: fixtureEntries(), graph: fixtureGraph() });
  assert.equal(context.version, 1);
  assert.equal(context.stats.groups, 3);
  assert.deepEqual(context.stats.byKind, { table: 1, form: 1, landmark: 1 });
  assert.equal(context.stats.landmarks, 1);
  assert.equal(context.stats.forms, 1);
  assert.equal(context.stats.tables, 1);
  assert.equal(context.stats.parented, 2);
  assert.equal(context.stats.depth, 2);
  const landmark = context.groups.find((group) => group.kind === 'landmark');
  const form = context.groups.find((group) => group.kind === 'form');
  const table = context.groups.find((group) => group.kind === 'table');
  assert.equal(landmark.name, '主区域');
  assert.equal(landmark.depth, 0);
  assert.equal(landmark.parentId, null);
  assert.equal(form.parentId, landmark.id);
  assert.equal(form.depth, 1);
  assert.equal(table.parentId, form.id);
  assert.equal(table.depth, 2);
  assert.deepEqual(landmark.childIds, [form.id]);
  assert.deepEqual(form.childIds, [table.id]);
  assert.deepEqual(context.roots, [landmark.id]);
  const inputContext = context.contexts.find((item) => item.node === '@input');
  assert.deepEqual(inputContext.kinds, ['table', 'form', 'landmark']);
  assert.deepEqual(inputContext.anchorIds, ['@table', '@form', '@main']);
  assert.deepEqual(inputContext.chain, [table.id, form.id, landmark.id]);
  const btnContext = context.contexts.find((item) => item.node === '@btn');
  assert.deepEqual(btnContext.kinds, ['landmark']);
  assert.equal(table.members, 1);
  assert.deepEqual(table.memberIds, ['@input']);
  assert.deepEqual(table.roles, { textbox: 1 });
  assert.ok(table.tokens > 0);
});

test('表格分组事实：表头名称/数量、行数、无题注', () => {
  const context = buildVomContext({ entries: fixtureEntries(), graph: fixtureGraph() });
  const table = context.groups.find((group) => group.kind === 'table');
  assert.ok(table.table, '表格组缺少 table 事实');
  assert.equal(table.table.headerCount, 1);
  assert.deepEqual(table.table.headers, [{ id: '@th', role: 'columnheader', name: '名称' }]);
  assert.equal(table.table.rowCount, 1);
  assert.equal(table.table.caption, null);
  assert.equal(table.table.hasHeaderRow, true);
  assert.equal(context.stats.tableHeaders, 1);
});

test('表格分组事实：caption 与 rowheader 也计入', () => {
  const context = buildVomContext({
    entries: [
      { id: '@in2', node: { id: 'i2', role: 'textbox', tag: 'input' }, ancestorIds: ['@table2'] },
    ],
    graph: {
      nodes: [
        { id: '@table2', domId: 't2', tag: 'table', role: 'table' },
        { id: '@cap', domId: 'cap', tag: 'caption', role: 'caption' },
        { id: '@rh', domId: 'rh', tag: 'th', role: 'rowheader', name: '编号' },
      ],
      edges: [
        { type: 'child', from: '@table2', to: '@cap' },
        { type: 'child', from: '@table2', to: '@rh' },
        { type: 'child', from: '@table2', to: '@in2' },
      ],
    },
  });
  const table = context.groups.find((group) => group.kind === 'table');
  assert.equal(table.table.caption, 'cap');
  assert.equal(table.table.headerCount, 1);
  assert.equal(table.table.headers[0].role, 'rowheader');
  assert.equal(table.table.headers[0].name, '编号');
});

test('没有页面图时用 entry 祖先事实建组并回填名称', () => {
  const context = buildVomContext({
    entries: [
      {
        id: '@x',
        node: {
          id: 'x-input',
          role: 'textbox',
          tag: 'input',
          ancestors: [
            { tag: 'form', id: 'login', name: '登录表单' },
            { tag: 'main', id: 'app', name: '应用' },
          ],
        },
      },
    ],
  });
  assert.equal(context.stats.groups, 2);
  const form = context.groups.find((group) => group.kind === 'form');
  const landmark = context.groups.find((group) => group.kind === 'landmark');
  assert.equal(form.name, '登录表单');
  assert.equal(landmark.name, '应用');
  assert.equal(form.parentId, landmark.id);
  const ctx = context.contexts[0];
  assert.deepEqual(ctx.kinds, ['form', 'landmark']);
  assert.deepEqual(ctx.anchorIds, ['dom:login', 'dom:app']);
});

test('节点自身是表格锚点时也进入上下文（观察到的 table 容器）', () => {
  const context = buildVomContext({
    entries: [{ id: '@tbl', node: { id: 'grid', role: 'grid', tag: 'div', name: '结果表' }, ancestorIds: [] }],
    graph: { nodes: [{ id: '@tbl', domId: 'grid', role: 'grid', tag: 'div' }], edges: [] },
  });
  assert.equal(context.groups.length, 1);
  const group = context.groups[0];
  assert.equal(group.kind, 'table');
  assert.equal(group.members, 1);
  assert.equal(group.name, '结果表');
  assert.equal(context.contexts[0].node, '@tbl');
});

test('跨 frame：命名空间 id 归到对应 frame，frames 汇总组/节点数', () => {
  const context = buildVomContext({
    entries: [
      { id: 'f1:@e1', node: { id: 'e1', role: 'textbox', tag: 'input' }, ancestorIds: ['f1:@form1'] },
    ],
    graph: {
      nodes: [
        { id: 'f1:@form1', domId: 'form1', role: 'form', tag: 'form' },
        { id: 'f1:@e1', domId: 'e1', role: 'textbox', tag: 'input' },
      ],
      edges: [{ type: 'child', from: 'f1:@form1', to: 'f1:@e1' }],
    },
    frames: [
      { frameId: 0, url: 'https://example.test/', parentFrameId: null },
      { frameId: 1, url: 'https://example.test/child', parentFrameId: 0 },
    ],
  });
  assert.equal(context.contexts[0].frameId, 1);
  assert.equal(context.groups[0].frameId, 1);
  assert.equal(context.frames.length, 2);
  const child = context.frames.find((frame) => frame.frameId === 1);
  assert.equal(child.nodes, 1);
  assert.equal(child.groups, 1);
  assert.equal(child.url, 'https://example.test/child');
  assert.equal(context.stats.framed, 1);
});

test('空输入与上限：结构稳定，组数超限标 truncated', () => {
  const empty = buildVomContext();
  assert.deepEqual(empty.groups, []);
  assert.deepEqual(empty.contexts, []);
  assert.deepEqual(empty.roots, []);
  assert.equal(empty.stats.groups, 0);
  assert.equal(empty.stats.truncated, false);
  const entries = [];
  for (let index = 0; index < 6; index += 1) {
    entries.push({
      id: '@n' + index,
      node: { id: 'n' + index, role: 'button', tag: 'button' },
      ancestorIds: ['@main' + index],
    });
  }
  const graph = {
    nodes: entries.map((entry, index) => ({ id: '@main' + index, domId: 'main' + index, role: 'main', tag: 'main' })),
    edges: [],
  };
  const limited = buildVomContext({ entries, graph, limits: { groups: 2 } });
  assert.equal(limited.groups.length, 2);
  assert.equal(limited.stats.truncated, true);
  // 默认上限常量存在且为整数。
  assert.ok(Number.isInteger(CONTEXT_LIMITS.groups) && CONTEXT_LIMITS.groups > 0);
});
